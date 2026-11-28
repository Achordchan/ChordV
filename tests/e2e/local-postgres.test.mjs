import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { prepareSupportIsolation } from "./support-isolation.mjs";
import { loadLocalEnvironment } from "../../scripts/mygo-local-config.mjs";
import { ensureLocalDatabase } from "../../scripts/mygo-local-db.mjs";
import { localPostgres } from "./local-postgres.mjs";

test("real psql quiet mode returns only SELECT/INSERT/UPDATE JSON, never command tags",async(t)=>{
  if(process.env.CHORDV_TEST_PSQL!=="1")return t.skip("设置CHORDV_TEST_PSQL=1显式运行独立PostgreSQL协议验收");
  const plan=await prepareSupportIsolation();
  let database;
  try {
    const local=await loadLocalEnvironment({root:plan.root,env:{CHORDV_LOCAL_API_PORT:String(plan.apiPort)}});
    database=await ensureLocalDatabase(local,{root:plan.root,env:process.env});
    const db=await localPostgres(local,{root:plan.root});
    assert.deepEqual(Object.keys(db).sort(), ["json", "sql"], "通用数据库工具不再暴露旧的public业务记录按行清理入口");
    assert.equal(db.cleanup, undefined);
    assert.deepEqual(await db.json("SELECT jsonb_build_object('selected',true);"),{selected:true});
    assert.deepEqual(await db.json(`CREATE TEMP TABLE psql_output_fixture(id int); INSERT INTO psql_output_fixture VALUES(1) RETURNING jsonb_build_object('inserted',id);`),{inserted:1});
    assert.deepEqual(await db.json(`CREATE TEMP TABLE psql_output_fixture(id int); INSERT INTO psql_output_fixture VALUES(1); UPDATE psql_output_fixture SET id=2 RETURNING jsonb_build_object('updated',id);`),{updated:2});
    const raw=await db.sql(`CREATE TEMP TABLE psql_output_fixture(id int); INSERT INTO psql_output_fixture VALUES(3) RETURNING jsonb_build_object('value',id);`);
    assert.deepEqual(JSON.parse(raw),{value:3});
    assert.doesNotMatch(raw,/INSERT 0|CREATE TABLE|UPDATE [0-9]/);
    await assert.rejects(db.sql("SELECT missing_fixture_column;"),/SQL 失败/);
  } finally {
    await database?.stop();
    await rm(plan.root,{recursive:true});
  }
});
