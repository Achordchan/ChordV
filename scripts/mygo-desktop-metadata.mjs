export function withMacBuildInfo(config, { build, release, architecture }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(config.version)
      || !Number.isSafeInteger(build) || build < 0 || (release && build === 0)
      || !["arm64", "x64"].includes(architecture)) {
    throw new Error("macOS 构建元数据无效");
  }
  return {
    ...config,
    macos: {
      ...config.macos,
      infoPlist: {
        ...config.macos?.infoPlist,
        ChordVBuildInfo: { version: config.version, build, mode: release ? "release" : "local", platform: "macos", architecture }
      }
    }
  };
}
