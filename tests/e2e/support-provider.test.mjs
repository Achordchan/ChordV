import assert from "node:assert/strict";
import test from "node:test";
import { createSupportProvider } from "./support-provider.mjs";
import { waitForState } from "./agent-harness.mjs";

const contact = { user:{id:"local-contact",name:"本地工单用户",email:"support-test@chordv.local"},context:{theme:"system",locale:"zh-CN",launchMode:"native"} };
const auth = (provider) => `Basic ${Buffer.from(`${provider.credentials.clientId}:${provider.credentials.clientSecret}`).toString("base64")}`;
async function issue(provider) {
  const response = await fetch(`${provider.origin}/api/v1/integrations/universal/launch-tickets`, { method:"POST",headers:{Authorization:auth(provider),"Content-Type":"application/json"},body:JSON.stringify(contact) });
  assert.equal(response.status,200);
  return (await response.json()).data;
}
const redeem = (provider, value, headers = {}) => fetch(`${provider.origin}/api/session/redeem`, { method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify({ticket:value}) });
const ticket = (launch) => new URLSearchParams(new URL(launch.launchUrl).hash.slice(1)).get("ticket");

test("real HTTP provider requires Basic auth and returns the actual launch envelope with a 60-second fragment ticket", async () => {
  const now = Date.now();
  const provider = await createSupportProvider({now:()=>now});
  try {
    const denied = await fetch(`${provider.origin}/api/v1/integrations/universal/launch-tickets`, {method:"POST",body:JSON.stringify(contact)});
    assert.equal(denied.status,401);
    const launch = await issue(provider);
    assert.equal(new URL(launch.launchUrl).origin,provider.origin);
    assert.equal(Date.parse(launch.expiresAt)-now,60000);
    assert.equal(ticket(launch).length,43);
    const page = await fetch(launch.launchUrl);
    assert.equal(page.status,200);
    assert.match(await page.text(),/本地工单联调/);
    assert.equal(page.headers.get("Cache-Control"),"no-store");
    assert.equal(page.headers.get("Referrer-Policy"),"no-referrer");
    assert.equal(provider.snapshot().redeemed,0,"loading HTML alone must not consume the fragment ticket");
  } finally { await provider.stop(); }
});

test("ticket redemption is one-use under concurrent requests and creates an HttpOnly session", async () => {
  const provider = await createSupportProvider();
  try {
    const launch = await issue(provider);
    const responses = await Promise.all([redeem(provider,ticket(launch)),redeem(provider,ticket(launch))]);
    assert.deepEqual(responses.map((response)=>response.status).sort(),[200,410]);
    const accepted = responses.find((response)=>response.status===200);
    const cookie = accepted.headers.get("Set-Cookie");
    assert.match(cookie,/HttpOnly; SameSite=Strict; Path=\//);
    const profile = await fetch(`${provider.origin}/api/session`,{headers:{Cookie:cookie.split(";")[0]}});
    assert.equal(profile.status,200);
    assert.equal((await profile.json()).data.user.name,contact.user.name);
    assert.equal(provider.snapshot().redeemed,1);
    assert.equal(provider.snapshot().replayed,1);
    assert.ok(Number.isFinite(Date.parse(profile.headers.get("Date"))));
  } finally { await provider.stop(); }
});

test("expired, unknown and foreign-origin tickets are rejected without being exchanged", async () => {
  let now = Date.now();
  const provider = await createSupportProvider({now:()=>now});
  try {
    const launch = await issue(provider);
    assert.equal((await redeem(provider,ticket(launch),{Origin:"https://example.invalid"})).status,403);
    now += 60001;
    const expired = await redeem(provider,ticket(launch));
    assert.equal(expired.status,410);
    assert.equal((await expired.json()).code,"TICKET_EXPIRED");
    assert.equal((await redeem(provider,"not-a-ticket")).status,401);
    assert.equal(provider.snapshot().redeemed,0);
  } finally { await provider.stop(); }
});

test("authenticated portal events use the expected bridge protocol and invalidate expired sessions", async () => {
  const observed = [];
  const provider = await createSupportProvider({onEvent:async(event)=>observed.push(event)});
  try {
    const launch = await issue(provider);
    const response = await redeem(provider,ticket(launch));
    const Cookie = response.headers.get("Set-Cookie").split(";")[0];
    const event = (input) => fetch(`${provider.origin}/api/session/bridge`, {method:"POST",headers:{Cookie,"Content-Type":"application/json"},body:JSON.stringify(input)});
    assert.equal((await event({type:"ready"})).status,200);
    assert.equal((await event({type:"unread-changed",unreadCount:7})).status,200);
    for (const value of [-1,1.5,100000]) assert.equal((await event({type:"unread-changed",unreadCount:value})).status,422);
    const unread = await fetch(`${provider.origin}/api/v1/integrations/universal/contacts/local-contact/unread`,{headers:{Authorization:auth(provider)}});
    assert.equal((await unread.json()).data.unreadCount,7);
    assert.equal((await event({type:"session-expired"})).status,200);
    assert.equal((await event({type:"close-requested"})).status,401);
    assert.equal((await fetch(`${provider.origin}/api/session`,{headers:{Cookie}})).status,401);
    assert.deepEqual(observed.map((value)=>value.type),["ready","unread-changed","session-expired"]);
    assert.equal(observed[1].userId,"local-contact");
    assert.equal(provider.snapshot().bridge.length,3);
  } finally { await provider.stop(); }
});

async function armDelay(provider) {
  const launch = await issue(provider);
  const session = await redeem(provider,ticket(launch));
  const Cookie = session.headers.get("Set-Cookie").split(";")[0];
  const response = await fetch(`${provider.origin}/api/session/next-launch-delay`,{method:"POST",headers:{Cookie,"Content-Type":"application/json"},body:"{}"});
  assert.equal(response.status,200);
  return { Cookie, ...(await response.json()).data };
}
const launchRequest = (provider,signal) => fetch(`${provider.origin}/api/v1/integrations/universal/launch-tickets`,{method:"POST",headers:{Authorization:auth(provider),"Content-Type":"application/json"},body:JSON.stringify(contact),signal});

test("portal arms a real three-second issuance delay once, scoped to its authenticated contact", async () => {
  const provider=await createSupportProvider();
  try {
    const armed=await armDelay(provider);
    assert.equal(armed.delayMs,3000);
    const other=await fetch(`${provider.origin}/api/v1/integrations/universal/launch-tickets`,{method:"POST",headers:{Authorization:auth(provider),"Content-Type":"application/json"},body:JSON.stringify({...contact,user:{...contact.user,id:"other-contact"}})});
    assert.equal(other.status,200);
    assert.equal(provider.snapshot().delayStarted,0);
    const started=performance.now();
    const pending=launchRequest(provider);
    await waitForState("真实签发延迟开始",()=>provider.snapshot().delayStarted===1,provider.events,2000);
    assert.equal(provider.snapshot().issued,2,"waiting must not mint a ticket early");
    const delayed=await pending;
    assert.equal(delayed.status,200);
    assert.ok(performance.now()-started>=2900,"default delay must really wait three seconds");
    const data=(await delayed.json()).data;
    assert.ok(Date.parse(data.expiresAt)>Date.now()+58000,"ticket lifetime starts after the delay");
    assert.equal((await launchRequest(provider)).status,200);
    assert.equal(provider.snapshot().delayStarted,1,"delay is consumed by exactly one launch");
    assert.equal(provider.snapshot().delayCompleted,1);
    assert.equal(provider.snapshot().pendingDelays,0);
  } finally {await provider.stop();}
});

test("delay control rejects anonymous callers, cross-origin requests and arbitrary delay values", async () => {
  const provider=await createSupportProvider();
  try {
    const endpoint=`${provider.origin}/api/session/next-launch-delay`;
    assert.equal((await fetch(endpoint,{method:"POST",body:"{}"})).status,401);
    const {Cookie}=await armDelay(provider);
    assert.equal((await fetch(endpoint,{method:"POST",headers:{Cookie,Origin:"https://example.invalid"},body:"{}"})).status,403);
    assert.equal((await fetch(endpoint,{method:"POST",headers:{Cookie},body:JSON.stringify({delayMs:60000})})).status,422);
    assert.equal(provider.snapshot().delayArmed,1);
  } finally {await provider.stop();}
});

test("HTTP caller cancellation aborts the pending delay and never creates a late ticket", async () => {
  const provider=await createSupportProvider();
  try {
    await armDelay(provider);
    const controller=new AbortController();
    const response=launchRequest(provider,controller.signal).then(value=>({value}),error=>({error}));
    await waitForState("取消前已收到真实请求",()=>provider.snapshot().delayStarted===1,provider.events,2000);
    controller.abort();
    assert.equal((await response).error?.name,"AbortError");
    await waitForState("HTTP取消清理定时器",()=>provider.snapshot().delayCancelled===1&&provider.snapshot().pendingDelays===0,provider.events,2000);
    assert.equal(provider.snapshot().issued,1);
    assert.equal(provider.snapshot().delayCompleted,0);
    assert.equal((await launchRequest(provider)).status,200,"cancelled request consumes the one-shot delay");
    assert.equal(provider.snapshot().delayStarted,1);
  } finally {await provider.stop();}
});

test("real HTTP timeout cancels delayed issuance without leaving a timer or ticket", async () => {
  const provider=await createSupportProvider();
  try {
    await armDelay(provider);
    const response=launchRequest(provider,AbortSignal.timeout(250)).then(value=>({value}),error=>({error}));
    await waitForState("超时前已收到真实请求",()=>provider.snapshot().delayStarted===1,provider.events,2000);
    assert.equal((await response).error?.name,"TimeoutError");
    await waitForState("HTTP超时清理定时器",()=>provider.snapshot().delayCancelled===1&&provider.snapshot().pendingDelays===0,provider.events,2000);
    assert.equal(provider.snapshot().issued,1);
    assert.equal(provider.snapshot().delayCompleted,0);
  } finally {await provider.stop();}
});

test("stopping the test provider aborts pending issuance without waiting the entire delay", async () => {
  const provider=await createSupportProvider();
  await armDelay(provider);
  const response=launchRequest(provider).then(value=>({value}),error=>({error}));
  await waitForState("停止前已收到真实请求",()=>provider.snapshot().delayStarted===1,provider.events,2000);
  await provider.stop();
  assert.ok((await response).error);
  assert.equal(provider.snapshot().pendingDelays,0);
  assert.equal(provider.snapshot().delayCancelled,1);
  assert.equal(provider.snapshot().issued,1);
});
