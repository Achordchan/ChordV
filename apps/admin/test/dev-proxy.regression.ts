import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage } from "node:http";
import { adaptLoopbackRefreshCookie } from "../dev-proxy";

const cookie = "chordv_admin_refresh=fixture; Path=/api/auth; HttpOnly; SameSite=None; Domain=api.example.com; Secure";
function adapt(options: {local?:string;peer?:string;host?:string;tls?:boolean} = {}) {
  const response = {headers:{"set-cookie":[cookie,"other=value; Secure"]}} as IncomingMessage;
  const request = {headers:{host:options.host ?? "127.0.0.1:5174"},socket:{localAddress:options.local ?? "127.0.0.1",remoteAddress:options.peer ?? "127.0.0.1",encrypted:options.tls}} as unknown as IncomingMessage;
  adaptLoopbackRefreshCookie(response, request);
  return response.headers["set-cookie"]!;
}
test("HTTP loopback retains HttpOnly/path and adapts only admin refresh",()=>{
  const result=adapt();assert.match(result[0],/HttpOnly/);assert.match(result[0],/Path=\/api\/auth/);assert.match(result[0],/SameSite=Lax/);assert.doesNotMatch(result[0],/Secure|Domain=/);assert.equal(result[1],"other=value; Secure");
});
test("remote peers, non-loopback hosts and TLS keep secure cookies",()=>{
  for(const options of [{peer:"192.0.2.1"},{local:"192.0.2.1"},{host:"api.example.com"},{tls:true}])assert.equal(adapt(options)[0],cookie);
});
