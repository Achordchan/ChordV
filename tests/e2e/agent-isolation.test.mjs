import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentPrivateDatabase, isolatedAgentEnvironment, readAgentLocalConfig, validateAgentSchema } from "./agent-isolation.mjs";
import { managedProcess, runBuild } from "./agent-harness.mjs";
import { localPostgres } from "./local-postgres.mjs";
import { PROJECT_ROOT } from "../../scripts/mygo-local-config.mjs";

test("agent acceptance rejects public, other test schemas, and quoted search-path injection", () => {
  for (const schema of ["public", "pg_catalog", "api_test_123", "chordv_agent_e2e_a", "chordv_agent_e2e_" + "a".repeat(32) + ",public", 'chordv_agent_e2e_";DROP SCHEMA public;--']) {
    assert.throws(() => validateAgentSchema(schema), /私有schema/);
  }
  const schema = "chordv_agent_e2e_" + "a".repeat(32);
  assert.equal(validateAgentSchema(schema), schema);
});

test("agent acceptance CLI rejects external API or reused binary arguments before loading local configuration", async () => {
  const proc = managedProcess(process.execPath, [path.join(PROJECT_ROOT, "scripts/mygo-agent-e2e.mjs"), "--api=http://127.0.0.1:3100"], { cwd: os.tmpdir(), env: { PATH: process.env.PATH } });
  try {
    await assert.rejects(proc.ready, /提前退出/);
    assert.equal(proc.child.exitCode, 1);
    assert.match(proc.diagnostic(), /不接受外部API、schema或二进制参数/);
    assert.doesNotMatch(proc.diagnostic(), /数据库|构建失败/);
  } finally { await proc.stop(); }
});

test("real isolated server rejects public and wrong ownership, private cleanup refuses a changed marker", async (t) => {
  if (process.env.CHORDV_TEST_AGENT_ISOLATION !== "1") return t.skip("设置CHORDV_TEST_AGENT_ISOLATION=1显式运行本地真实schema隔离验收");
  const config = await readAgentLocalConfig();
  const db = await agentPrivateDatabase(config);
  const control = await localPostgres(config);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "chordv-agent-isolation-test-"));
  const processes = [];
  const publicBefore = await db.publicSnapshot();
  let changedMarker = false;
  try {
    const env = isolatedAgentEnvironment(config, temporary, db.schema);
    await db.create();
    assert.equal(await db.sql("SHOW statement_timeout;"), "20s");
    assert.equal(await db.sql("SHOW lock_timeout;"), "5s");
    const program = path.join(temporary, "server");
    const buildEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("CHORDV_")));
    await runBuild("go", ["build", "-tags=e2e", "-o", program, "./internal/e2e/cmd/isolated-server"], { cwd: path.join(PROJECT_ROOT, "apps/server"), env: buildEnv });
    for (const [label, extra, expected] of [
      ["public schema", { CHORDV_AGENT_E2E_SCHEMA: "public", CHORDV_AGENT_E2E_SCHEMA_NONCE: db.nonce }, /本次私有schema身份/],
      ["inherited default search path", { CHORDV_AGENT_E2E_SCHEMA: "", CHORDV_AGENT_E2E_SCHEMA_NONCE: db.nonce }, /本次私有schema身份/],
      ["wrong schema nonce", { CHORDV_AGENT_E2E_SCHEMA_NONCE: randomBytes(32).toString("hex") }, /schema归属或search_path不匹配/]
    ]) {
      const proc = managedProcess(program, [], { cwd: temporary, env: { ...env, ...extra } });
      processes.push(proc);
      await assert.rejects(proc.ready, /提前退出/, label);
      assert.equal(proc.child.exitCode, 1, label);
      assert.match(proc.diagnostic(), expected, label);
    }
    assert.equal(await db.sql(`SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname='${db.schema}';`), "0", "拒绝阶段不能创建业务表");
    await control.sql(`COMMENT ON SCHEMA "${db.schema}" IS 'changed-by-owned-test';`);
    changedMarker = true;
    await assert.rejects(db.sql("SELECT 1"), /归属已变化/);
    await assert.rejects(db.cleanup(), /归属已变化/);
    assert.equal(await control.sql(`SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='${db.schema}';`), "1", "身份变化后应保留schema而非宽松删除");
    await control.sql(`COMMENT ON SCHEMA "${db.schema}" IS '${db.nonce}';`);
    changedMarker = false;
    assert.deepEqual(await db.cleanup(), { schema: db.schema, created: true, remaining: 0 });
    assert.deepEqual(await db.publicSnapshot(), publicBefore);
  } finally {
    for (const proc of processes) await proc.stop();
    if (changedMarker) await control.sql(`COMMENT ON SCHEMA "${db.schema}" IS '${db.nonce}';`);
    await db.cleanup();
    await rm(temporary, { recursive: true });
  }
});

test("interrupting real agent acceptance exits through owned process and schema cleanup", async (t) => {
  if (process.env.CHORDV_TEST_AGENT_ISOLATION !== "1") return t.skip("设置CHORDV_TEST_AGENT_ISOLATION=1显式运行真实中断清理验收");
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "scripts/mygo-agent-e2e.mjs")], { cwd: PROJECT_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", error = "", interrupted = false;
  const limit = setTimeout(() => child.kill("SIGTERM"), 30000);
  child.stdout.on("data", (data) => {
    out += data;
    if (!interrupted && out.includes("当前源码构建的独立Go后台")) {
      interrupted = true;
      child.kill("SIGINT");
    }
  });
  child.stderr.on("data", (data) => { error = (error + data).slice(-32768); });
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(interrupted, true, error);
    assert.deepEqual(result, { code: 1, signal: null });
    const match = out.match(/报告：([^\n]+)\n/);
    assert.ok(match, out + error);
    const report = JSON.parse(await readFile(match[1], "utf8"));
    assert.equal(report.result, "failed");
    assert.equal(report.interruption, "SIGINT");
    assert.match(report.error, /SIGINT/);
    assert.equal(report.cleaned, true);
    assert.equal(report.schemaCleanup.remaining, 0);
    assert.equal(report.processesStopped, true);
    assert.deepEqual(report.cleanupErrors, []);
    assert.equal(report.publicData.unchanged, true);
    const control = await localPostgres(await readAgentLocalConfig());
    assert.equal(await control.sql(`SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='${validateAgentSchema(report.schema)}';`), "0");
    assert.equal(path.dirname(report.retainedTemporary), path.resolve(os.tmpdir()));
    assert.match(path.basename(report.retainedTemporary), /^chordv-agent-e2e-/);
    await rm(report.retainedTemporary, { recursive: true });
    t.diagnostic(`真实SIGINT失败报告保留于 ${match[1]}；报告确认进程/schema清理后，仅删除该报告标明的自有临时构建目录`);
  } finally { clearTimeout(limit); }
});

test("agent acceptance server gets isolated paths and secrets, not inherited main API or proxy credentials", () => {
  const config = {
    CHORDV_LOCAL_DATABASE_URL: "postgresql://chordv_local:private@127.0.0.1:55437/chordv_mygo_local?sslmode=disable",
    CHORDV_LOCAL_JWT_SECRET: "a".repeat(48), CHORDV_LOCAL_AGENT_PEPPER: "b".repeat(48)
  };
  const env = isolatedAgentEnvironment(config, "/private/owned/agent-e2e", "chordv_agent_e2e_" + "a".repeat(32), {
    PATH: "/go/bin:/usr/bin", HOME: "/home/test", DATABASE_URL: "remote", CHORDV_API_BASE_URL: "http://127.0.0.1:3100",
    CHORDV_LOCAL_LISTEN: "127.0.0.1:3100", CHORDV_LOCAL_DATA_DIR: "/main/data", HTTP_PROXY: "secret", PGOPTIONS: "-c search_path=public"
  });
  assert.equal(env.CHORDV_LOCAL_LISTEN, "127.0.0.1:0");
  assert.equal(env.CHORDV_LOCAL_DATA_DIR, "/private/owned/agent-e2e/server-data");
  assert.equal(env.CHORDV_LOCAL_DATABASE_URL, config.CHORDV_LOCAL_DATABASE_URL);
  assert.notEqual(env.CHORDV_LOCAL_JWT_SECRET, config.CHORDV_LOCAL_JWT_SECRET);
  assert.notEqual(env.CHORDV_LOCAL_AGENT_PEPPER, config.CHORDV_LOCAL_AGENT_PEPPER);
  for (const name of ["DATABASE_URL", "CHORDV_API_BASE_URL", "HTTP_PROXY", "PGOPTIONS"]) assert.equal(env[name], undefined, name);
  for (const bad of ["postgresql://chordv_local:x@example.org:55437/chordv_mygo_local", "postgresql://chordv_local:x@127.0.0.1:55437/postgres", config.CHORDV_LOCAL_DATABASE_URL + "&options=-csearch_path%3Dpublic"]) {
    assert.throws(() => isolatedAgentEnvironment({ ...config, CHORDV_LOCAL_DATABASE_URL: bad }, "/private/owned/agent-e2e", "chordv_agent_e2e_" + "a".repeat(32)), /数据库|参数/);
  }
});
