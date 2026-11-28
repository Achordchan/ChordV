import assert from "node:assert/strict";
import { resolveLocalApiBase } from "../src/lib/localEndpoint";

assert.equal(resolveLocalApiBase(undefined), "http://127.0.0.1:3100");
assert.equal(resolveLocalApiBase("http://localhost:3100/"), "http://localhost:3100");
assert.equal(resolveLocalApiBase(" http://[::1]:3100 "), "http://[::1]:3100");
for (const value of [
  "https://v.achord.cn",
  "https://production.example",
  "http://127.0.0.1.production.example:3100",
  "http://127.0.0.1:3100@production.example",
  "http://user:secret@127.0.0.1:3100",
  "http://127.0.0.1:3100/api",
  "http://127.0.0.1:3100?target=production",
  "http://127.0.0.1:3100#production",
  "file:///etc/passwd",
  "not-a-url"
]) assert.throws(() => resolveLocalApiBase(value));
console.log("客户端本地API隔离：回环地址、凭据/路径/远端拒绝检查通过");
