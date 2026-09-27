import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdminUserClientVersionDto } from "@chordv/shared";
import {
  compareClientVersion,
  formatClientLastSeen,
  formatClientVersion,
  formatClientVersionDetail,
  latestClientVersion,
  summarizeClientVersions
} from "../src/utils/client-versions";

const now = Date.parse("2026-09-27T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function entry(overrides: Partial<AdminUserClientVersionDto>): AdminUserClientVersionDto {
  return { platform: "macos", version: "1.1.10", build: null, channel: "stable", lastSeenAt: ago(HOUR), ...overrides };
}

assert.equal(formatClientVersion(entry({})), "1.1.10 · macOS");
assert.equal(formatClientVersion(entry({ platform: "windows", version: "1.1.9" })), "1.1.9 · Windows");
assert.equal(formatClientVersionDetail(entry({ build: 3, channel: "beta" })), "1.1.10 · 构建 3 · macOS · 测试版");
assert.equal(formatClientVersionDetail(entry({})), "1.1.10 · macOS");

assert.equal(formatClientLastSeen(ago(10_000), now), "刚刚");
assert.equal(formatClientLastSeen(ago(5 * 60_000), now), "5 分钟前");
assert.equal(formatClientLastSeen(ago(3 * HOUR), now), "3 小时前");
assert.equal(formatClientLastSeen(ago(2 * DAY), now), "2 天前");
assert.equal(formatClientLastSeen("bad", now), "时间未知");

assert.equal(latestClientVersion({ clientVersions: [entry({ platform: "windows", lastSeenAt: ago(DAY) }), entry({ lastSeenAt: ago(HOUR) })] })?.platform, "macos", "取最近使用的平台");
assert.equal(latestClientVersion({}), null, "旧接口没有该字段时不报错");

assert.ok(compareClientVersion("1.1.10", "1.1.9") > 0, "1.1.10 比 1.1.9 新");
assert.ok(compareClientVersion("1.1.10", "1.1.10-beta.1") > 0, "正式版比同号预发布新");
assert.equal(compareClientVersion("1.1.10", "1.1.10"), 0);

const summary = summarizeClientVersions([
  { id: "a", clientVersions: [entry({ platform: "macos" }), entry({ platform: "windows" })] },
  { id: "b", clientVersions: [entry({ version: "1.1.9", platform: "windows" })] },
  { id: "c", clientVersions: [entry({ version: "1.1.9", platform: "macos", lastSeenAt: ago(8 * DAY) })] },
  { id: "d" },
  { id: "e", clientVersions: [entry({ version: "1.1.9", platform: "macos", lastSeenAt: ago(2 * DAY) })] }
], now);
assert.equal(summary.activeUsers, 3, "只统计近 7 天使用过的用户，超过 7 天和没有记录的不算");
assert.deepEqual(summary.versions.map((item) => [item.version, item.users]), [["1.1.10", 1], ["1.1.9", 2]], "按版本从新到旧排列，同一用户多平台同版本只算一人");
assert.deepEqual(summary.versions[0].platforms.map((item) => [item.label, item.users]), [["macOS", 1], ["Windows", 1]]);
assert.deepEqual(summarizeClientVersions([], now), { activeUsers: 0, versions: [] });

const overview = readFileSync(resolve(import.meta.dirname, "../src/pages/OverviewPage.tsx"), "utf8");
assert.match(overview, /summarizeClientVersions\(snapshot\.users, now\)/, "仪表台展示客户端版本分布");
const customers = ["CustomerWorkspace.tsx", "CustomerMembers.tsx"].map((file) => readFileSync(resolve(import.meta.dirname, "../src/features/customers", file), "utf8")).join("\n");
assert.match(customers, /<ClientVersionBrief user=\{customer\.user\}\/>/, "客户列表显示客户端版本");
assert.match(customers, /<ClientVersionFacts user=\{customer\.user\}\/>/, "账号资料显示客户端版本");
assert.match(customers, /<Table\.Th>客户端<\/Table\.Th>/, "团队成员表显示客户端版本");

console.log("admin client version checks passed");
