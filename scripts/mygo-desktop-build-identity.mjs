export function desktopBuildIdentity({ version, build, mode, platform, architecture, commit }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version ?? "")
      || !Number.isSafeInteger(build) || build < (mode === "release" ? 1 : 0) || !["local", "release"].includes(mode)
      || !["macos", "windows", "linux"].includes(platform) || !["x64", "arm64"].includes(architecture) || !/^[a-f0-9]{40,64}$/.test(commit ?? "")) throw new Error("Invalid desktop build identity");
  return { version, build, mode, platform, architecture, commit };
}

// Go's linker-owned build ID survives trimpath and is covered by the platform
// signature. It is metadata, not a signature or an independent trust root.
export function desktopBuildID(identity) {
  return `chordv1:${Buffer.from(JSON.stringify(desktopBuildIdentity(identity))).toString("base64url")}`;
}

export function parseDesktopBuildID(raw) {
  if (!/^chordv1:[A-Za-z0-9_-]+$/.test(raw ?? "") || raw.length > 1024) throw new Error("Missing embedded ChordV desktop build identity");
  const identity = desktopBuildIdentity(JSON.parse(Buffer.from(raw.slice(8), "base64url").toString("utf8")));
  if (desktopBuildID(identity) !== raw) throw new Error("Noncanonical desktop build identity");
  return identity;
}
