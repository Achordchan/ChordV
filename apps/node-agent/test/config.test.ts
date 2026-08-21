import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalXrayAddress, assertSafeApiBaseUrl } from '../src/config.js';

test('Xray API 只允许 Unix Socket 或 loopback', () => {
  for (const address of ['127.0.0.1:10085', 'localhost:10085', '[::1]:10085', 'unix:/run/xray/api.sock']) {
    assert.doesNotThrow(() => assertLocalXrayAddress(address));
  }
  assert.throws(() => assertLocalXrayAddress('0.0.0.0:10085'));
  assert.throws(() => assertLocalXrayAddress('10.0.0.8:10085'));
});

test('远程 Agent API 强制 HTTPS', () => {
  assert.doesNotThrow(() => assertSafeApiBaseUrl('https://v.example.com'));
  assert.doesNotThrow(() => assertSafeApiBaseUrl('http://127.0.0.1:3000'));
  assert.throws(() => assertSafeApiBaseUrl('http://v.example.com'));
});
