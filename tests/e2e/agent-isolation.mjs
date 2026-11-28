import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT, validateLocalEnvironment } from "../../scripts/mygo-local-config.mjs";
import { localPostgres } from "./local-postgres.mjs";

export function validateAgentSchema(schema) {
  if (typeof schema !== "string" || !/^chordv_agent_e2e_[a-f0-9]{32}$/.test(schema)) throw new Error("Agent验收必须使用本次随机私有schema");
  return schema;
}

export async function readAgentLocalConfig(root = PROJECT_ROOT) {
  const config = JSON.parse(await readFile(path.join(root, ".data/mygo/local-env.json"), "utf8"));
  for (const name of Object.keys(config)) if (!/^CHORDV_LOCAL_(DATABASE_URL|JWT_SECRET|AGENT_PEPPER)$/.test(name)) throw new Error("本地验收配置含未知字段");
  return validateLocalEnvironment(config);
}

export function isolatedAgentEnvironment(config, temporary, schema, source = process.env) {
  validateLocalEnvironment(config);
  validateAgentSchema(schema);
  if (!path.isAbsolute(temporary) || temporary === path.parse(temporary).root) throw new Error("Agent验收需要独立绝对路径");
  const env = Object.fromEntries(Object.entries(source).filter(([key]) => ["PATH", "HOME", "TMPDIR", "SystemRoot", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "GOPATH", "GOMODCACHE", "GOCACHE", "GOTOOLCHAIN", "GOPROXY", "GOSUMDB"].includes(key)));
  return {
    ...env, CHORDV_MODE: "local", CHORDV_LOCAL_LISTEN: "127.0.0.1:0",
    CHORDV_LOCAL_DATABASE_URL: config.CHORDV_LOCAL_DATABASE_URL,
    CHORDV_LOCAL_JWT_SECRET: randomBytes(48).toString("hex"),
    CHORDV_LOCAL_AGENT_PEPPER: randomBytes(48).toString("hex"),
    CHORDV_LOCAL_DATA_DIR: path.join(temporary, "server-data"),
    CHORDV_LOCAL_ORIGINS: "http://127.0.0.1:5174",
    CHORDV_AGENT_E2E_SCHEMA: schema, CGO_ENABLED: "0"
  };
}

export async function agentPrivateDatabase(config, { root = PROJECT_ROOT } = {}) {
  validateLocalEnvironment(config);
  const base = await localPostgres(config, { root });
  const sql = (query) => base.sql(`SET statement_timeout='20s'; SET lock_timeout='5s'; ${query}`);
  const schema = validateAgentSchema(`chordv_agent_e2e_${randomBytes(16).toString("hex")}`);
  const nonce = randomBytes(32).toString("hex");
  let created = false;
  const owns = () => sql(`SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='${schema}' AND pg_catalog.obj_description(oid,'pg_namespace')='${nonce}' AND pg_catalog.pg_get_userbyid(nspowner)=current_user;`);
  const assertOwned = async () => { assert.equal(await owns(), "1", "本次私有schema归属已变化，停止执行"); };
  return {
    schema, nonce,
    async create() {
      if (created) throw new Error("私有schema已创建");
      await sql(`BEGIN; CREATE SCHEMA "${schema}"; COMMENT ON SCHEMA "${schema}" IS '${nonce}'; COMMIT;`);
      created = true;
      await assertOwned();
    },
    async sql(query) {
      if (!created) throw new Error("私有schema尚未创建");
      await assertOwned();
      return sql(`SET search_path TO "${schema}",pg_catalog; ${query}`);
    },
    async json(query) { return JSON.parse(await this.sql(query)); },
    async publicSnapshot() {
      const names = JSON.parse(await sql("SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]'::json) FROM pg_catalog.pg_tables WHERE schemaname='public';"));
      const tables = [];
      for (const name of names) {
        const quoted = '"' + name.replaceAll('"', '""') + '"';
        const values = JSON.parse(await sql(`SELECT json_build_object('rows',count(*),'digest',md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text)::text,'[]'))) FROM public.${quoted} t;`));
        tables.push({ name, ...values });
      }
      return tables;
    },
    async cleanup() {
      if (!created) return { schema, created: false, remaining: 0 };
      await assertOwned();
      await sql(`DROP SCHEMA "${schema}" CASCADE;`);
      const remaining = Number(await sql(`SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname='${schema}';`));
      assert.equal(remaining, 0, "私有schema清理未完成");
      created = false;
      return { schema, created: true, remaining };
    }
  };
}
