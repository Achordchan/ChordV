import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeInboundUsersWithStats } from '../src/xray-adapter.js';

test('Handler 中存在但尚无 Stats 项的用户建立零流量基线', () => {
  const counters = mergeInboundUsersWithStats(
    [{ email: 'active@example.com' }, { email: 'idle@example.com' }],
    [{ username: 'active@example.com', uplink: 12, downlink: 34 }],
  );

  assert.deepEqual(counters, [
    { email: 'active@example.com', uplinkBytes: '12', downlinkBytes: '34' },
    { email: 'idle@example.com', uplinkBytes: '0', downlinkBytes: '0' },
  ]);
});

test('只采样目标 inbound 用户，不混入其他 inbound 的 Stats', () => {
  const counters = mergeInboundUsersWithStats(
    [{ email: 'target@example.com' }],
    [
      { username: 'target@example.com', uplink: 1, downlink: 2 },
      { username: 'other-inbound@example.com', uplink: 99, downlink: 99 },
    ],
  );

  assert.deepEqual(counters, [
    { email: 'target@example.com', uplinkBytes: '1', downlinkBytes: '2' },
  ]);
});
