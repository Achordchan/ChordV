import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Use the actual request and session code with a private browser store and controlled HTTP responses.
const source = readFileSync(new URL("../src/api/base.ts", import.meta.url), "utf8").replaceAll("import.meta.env", "({ DEV: false })");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
for (const failure of [503, 429, "network", "malformed", 401, 403, "non-admin"]) {
  const store = new Map<string, string>(), notices: string[] = [];
  const session = { accessToken: "before", refreshToken: "refresh", user: { role: "admin", email: "local@test.invalid" } };
  const api: any = {};
  let recovered = false, writes = 0;
  const fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/auth/refresh")) {
      if (recovered) return Response.json({ ...session, accessToken: "after" });
      if (failure === "network") throw Error("network down");
      if (failure === "malformed") return Response.json({});
      if (failure === "non-admin") return Response.json({ ...session, user: { role: "user" } });
      return new Response(null, { status: Number(failure) });
    }
    writes++;
    return (init.headers as Record<string,string>).Authorization === "Bearer after" ? Response.json({ ok: true }) : Response.json({message:"访问令牌无效"}, {status:401});
  };
  new Function("exports", "fetch", "localStorage", "window", js)(api, fetch,
    {setItem:(k:string,v:string)=>store.set(k,v),getItem:(k:string)=>store.get(k)??null,removeItem:(k:string)=>store.delete(k)},
    {location:{origin:"http://127.0.0.1"},setTimeout,clearTimeout,dispatchEvent:(e:Event)=>notices.push(e.type)});
  api.persistAdminSessionTokens(session);
  await assert.rejects(api.request("/admin/example", { method:"POST" }));
  assert.equal(writes, 1, "failed refresh must not replay the business request");
  const terminal = failure === 401 || failure === 403 || failure === "non-admin";
  assert.equal(api.getStoredAdminAccessToken(), terminal ? "" : "before", `refresh ${failure}`);
  assert.equal(notices.length, terminal ? 1 : 0);
  if (!terminal) {
    assert.equal(api.getStoredAdminProfile().email, session.user.email);
    recovered = true;
    assert.deepEqual(await api.request("/admin/example", { method:"POST" }), {ok:true});
    assert.equal(writes, 3);
  }
}

for (const stage of ["request", "refresh", "retry"]) for (const status of [200, 401]) {
  let resume!: () => void, entered!: () => void, writes = 0, refreshes = 0, expired = 0;
  const gate = new Promise<void>(r => { resume = r; }), waiting = new Promise<void>(r => { entered = r; });
  const api: any = {};
  const session = (token: string) => ({ accessToken: token, refreshToken: "test-only", user: { role: "admin", email: `${token}@example.invalid` } });
  const fetch = async (url: string) => {
    const isRefresh = url.endsWith("/auth/refresh");
    const step = isRefresh ? (refreshes++, "refresh") : ++writes === 1 ? "request" : "retry";
    if (step === stage) { entered(); await gate; }
    const code = step === stage ? status : isRefresh || step === "retry" ? 200 : 401;
    return Response.json(code === 401 ? {message:"访问令牌无效"} : isRefresh ? session("former-rotated") : {ok:true}, {status:code});
  };
  new Function("exports", "fetch", "localStorage", "window", js)(api,fetch,{setItem(){},removeItem(){}},
    {location:{origin:"http://127.0.0.1"},setTimeout,clearTimeout,dispatchEvent:()=>expired++});
  api.persistAdminSessionTokens(session("former"));
  const old = api.request("/admin/example", {method:"POST"}); await waiting;
  api.clearStoredAdminSession(); api.persistAdminSessionTokens(session("current")); resume();
  await assert.rejects(old, /会话已变更/, `${stage} ${status}`);
  assert.equal(api.getStoredAdminAccessToken(), "current"); assert.equal(expired, 0);
  assert.equal(writes, stage === "retry" ? 2 : 1); assert.equal(refreshes, stage === "request" ? 0 : 1);
}
