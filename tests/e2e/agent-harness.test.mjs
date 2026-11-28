import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { managedProcess, transparentAgentProxy, waitForState } from "./agent-harness.mjs";

test("event-driven state checks retain a change delivered during an asynchronous read", async () => {
  const events = new EventEmitter();
  let calls = 0;
  const result = await waitForState("event", async () => {
    calls++;
    if (calls === 1) { events.emit("change"); await Promise.resolve(); return false; }
    return "settled";
  }, events, 1000);
  assert.equal(result, "settled");
  assert.equal(calls, 2);
  assert.equal(events.listenerCount("change"), 0);
});

test("state timeout removes its event listener", async () => {
  const events = new EventEmitter();
  await assert.rejects(waitForState("expected", () => false, events, 20), /expected超时/);
  assert.equal(events.listenerCount("change"), 0);
});

test("JSON process RPC matches request IDs and cleans up the child", async () => {
  const source = `process.stdout.write(JSON.stringify({event:'ready',node:{local:true}})+'\\n');require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);process.stdout.write(JSON.stringify({id:r.id,data:r.action})+'\\n')})`;
  const child = managedProcess(process.execPath, ["-e", source]);
  try {
    assert.deepEqual(await child.ready, { local: true });
    assert.equal(await child.rpc("snapshot"), "snapshot");
  } finally { await child.stop(); }
  assert.ok(child.child.exitCode !== null || child.child.signalCode !== null);
});

test("concurrent cleanup sends SIGTERM once and waits for the actual child to exit", { skip: process.platform === "win32" }, async t => {
  const source = `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),25));setInterval(()=>{},1000);process.stdout.write(JSON.stringify({event:'ready',node:{local:true}})+'\\n');`;
  for (const signalFirst of [false, true]) await t.test(signalFirst ? "signal handler then cleanup" : "two cleanup callers", async () => {
    const proc = managedProcess(process.execPath, ["-e", source]);
    const sent = [];
    const kill = proc.child.kill.bind(proc.child);
    proc.child.kill = (signal) => { sent.push(signal); return kill(signal); };
    try {
      await proc.ready;
      if (signalFirst) proc.requestStop();
      await Promise.all([proc.stop(), proc.stop()]);
      assert.deepEqual(sent, ["SIGTERM"]);
      assert.equal(proc.child.exitCode, 0);
    } finally { await proc.stop(); }
  });
});

test("transparent proxy captures real request bytes and replays exactly without synthesizing results", async () => {
  const requests = [];
  const origin = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ body, authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ duplicate: requests.length > 1 }));
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const proxy = await transparentAgentProxy(`http://127.0.0.1:${origin.address().port}`);
  try {
    const raw = '{ "bootId": "test", "sequence":"1", "samples": [] }';
    const response = await fetch(`${proxy.url}/api/agent/v1/usage-batches`, { method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer test-only"},body:raw });
    assert.deepEqual(await response.json(), { duplicate:false });
    const batch = await waitForState("capture", () => proxy.batches[0], proxy.events, 1000);
    assert.equal(batch.body.toString(),raw);
    assert.deepEqual(await proxy.replay(batch), { duplicate:true });
    assert.deepEqual(requests[1],requests[0]);
  } finally {
    await proxy.stop();
    await new Promise((resolve)=>origin.close(resolve));
  }
});

test("paused metering retains original request bytes and waits for the real server reply", async () => {
  const requests = [];
  const origin = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"accepted":true,"ackThrough":"7"}');
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const proxy = await transparentAgentProxy(`http://127.0.0.1:${origin.address().port}`);
  const release = proxy.holdUsageRequests();
  try {
    const raw = '{ "sequence": "7", "samples": [] }';
    let received = false;
    const response = fetch(`${proxy.url}/api/agent/v1/usage-batches`, { method:"POST",body:raw }).then((value) => { received = true; return value; });
    await waitForState("held request", () => proxy.heldUsageRequestCount === 1, proxy.events, 1000);
    assert.equal(requests.length, 0);
    assert.equal(received, false);
    release();
    assert.equal(await (await response).text(), '{"accepted":true,"ackThrough":"7"}');
    assert.deepEqual(requests, [raw]);
  } finally {
    release();
    await proxy.stop();
    await new Promise((resolve)=>origin.close(resolve));
  }
});
