import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";

const profileLimit = 2 * 1024 * 1024;
const bundleID = "app.chordv.desktop";
const applicationKey = "com.apple.application-identifier";
const teamKey = "com.apple.developer.team-identifier";
const groupsKey = "keychain-access-groups";

function tool(command, args, input) {
  return execFileSync(command, args, { input, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000, maxBuffer: profileLimit });
}

function signingScope(identity) {
  const team = /^Developer ID Application: [^\r\n]+ \(([A-Z0-9]{10})\)$/.exec(identity ?? "")?.[1];
  if (!team) throw new Error("受保护更新的签名身份必须包含明确的 Developer ID 团队");
  return { team, app: `${team}.${bundleID}`, group: `${team}.${bundleID}.update-recovery` };
}

export function readMacRecoveryProfileClaims(plist) {
  try {
    const get = (key, format, type) => tool("/usr/bin/plutil", ["-extract", key, format, "-expect", type, "-o", "-", "--", "-"], plist).toString("utf8").trim();
    return {
      teams: JSON.parse(get("TeamIdentifier", "json", "array")),
      allDevices: get("ProvisionsAllDevices", "raw", "bool") === "true",
      expires: Date.parse(get("ExpirationDate", "raw", "date")),
      entitlements: JSON.parse(get("Entitlements", "json", "dictionary"))
    };
  } catch {
    throw new Error("受保护更新所需的 provisioning profile 字段不完整或格式无效");
  }
}

export function macRecoverySigningEntitlements(claims, identity, now = Date.now()) {
  const { team, app, group } = signingScope(identity);
  const { teams, allDevices, expires, entitlements } = claims;
  if (!Array.isArray(teams) || teams.length !== 1 || teams[0] !== team || entitlements?.[teamKey] !== team || entitlements?.[applicationKey] !== app) {
    throw new Error("受保护更新的 provisioning profile 与签名团队或应用标识不匹配");
  }
  if (allDevices !== true || !Number.isFinite(expires) || expires <= now || entitlements["get-task-allow"] === true || entitlements["com.apple.security.get-task-allow"] === true) {
    throw new Error("受保护更新需要未过期的 Developer ID 分发 profile");
  }
  const groups = entitlements[groupsKey];
  if (!Array.isArray(groups) || !groups.some(value => value === group || value === `${team}.*`)) {
    throw new Error("provisioning profile 未授权该应用的钥匙串访问组");
  }
  // A wildcard in a profile authorizes matching exact names, never a wildcard in the signature.
  return { [applicationKey]: app, [teamKey]: team, [groupsKey]: [group] };
}

export async function readMacRecoveryProfileFile(file) {
  if (!path.isAbsolute(file)) throw new Error("受保护更新的 provisioning profile 必须使用绝对路径");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > profileLimit) throw new Error("受保护更新的 provisioning profile 不是有效的普通文件");
    const buffer = Buffer.alloc(info.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw new Error("读取期间 provisioning profile 长度发生变化");
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

export async function prepareMacRecoverySigning(macos, profile, directory) {
  const copy = path.join(directory, "update-recovery.provisionprofile");
  const entitlements = path.join(directory, "update-recovery.entitlements.plist");
  await writeFile(copy, await readMacRecoveryProfileFile(profile), { mode: 0o600, flag: "wx" });
  let plist;
  try { plist = tool("/usr/bin/security", ["cms", "-D", "-i", copy]); }
  catch { throw new Error("无法解码受保护更新的 provisioning profile"); }
  const claims = macRecoverySigningEntitlements(readMacRecoveryProfileClaims(plist), macos.signingIdentity);
  const xml = tool("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], JSON.stringify(claims));
  await writeFile(entitlements, xml, { mode: 0o600, flag: "wx" });
  return { ...macos, provisioningProfile: copy, entitlements };
}

export function requireMacRecoverySignedClaims(actual, identity) {
  const { team, app, group } = signingScope(identity);
  const groups = actual?.[groupsKey];
  if (Object.keys(actual ?? {}).length !== 3 || actual?.[applicationKey] !== app || actual?.[teamKey] !== team ||
      !Array.isArray(groups) || groups.length !== 1 || groups[0] !== group) {
    throw new Error("签名安装包未使用精确的受保护更新钥匙串权限");
  }
}

export async function verifyMacRecoverySigning(app, source, profile, identity) {
  const name = "Contents/embedded.provisionprofile";
  const expected = await readMacRecoveryProfileFile(profile);
  for (const bundle of [app, source]) {
    if (!(await readMacRecoveryProfileFile(path.join(bundle, name))).equals(expected)) {
      throw new Error("签名安装包未包含本次选定的 provisioning profile");
    }
  }
  let actual;
  try {
    const plist = tool("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", app]);
    actual = JSON.parse(tool("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], plist));
  } catch { throw new Error("无法读取签名安装包的钥匙串权限"); }
  requireMacRecoverySignedClaims(actual, identity);
}
