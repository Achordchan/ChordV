import { mkdirSync, existsSync, chmodSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const binDir = path.join(tauriRoot, "bin");

const targetMap = {
  "darwin-arm64": {
    asset: "Xray-macos-arm64-v8a.zip",
    binaryName: "xray-aarch64-apple-darwin"
  },
  "darwin-x64": {
    asset: "Xray-macos-64.zip",
    binaryName: "xray-x86_64-apple-darwin"
  }
};

const key = `${process.platform}-${process.arch}`;
const target = targetMap[key];

if (!target) {
  console.error(`当前平台不支持自动下载 xray：${key}`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });

const outputBinary = path.join(binDir, target.binaryName);
const outputGeoIp = path.join(binDir, "geoip.dat");
const outputGeoSite = path.join(binDir, "geosite.dat");

if (
  existsSync(outputBinary) &&
  existsSync(outputGeoIp) &&
  existsSync(outputGeoSite) &&
  process.env.CHORDV_XRAY_FORCE !== "1"
) {
  console.log(`xray 资源已存在：${outputBinary}`);
  process.exit(0);
}

const tempRoot = path.join(tmpdir(), `chordv-xray-${Date.now()}`);
const zipPath = path.join(tempRoot, target.asset);
const extractDir = path.join(tempRoot, "extract");

mkdirSync(tempRoot, { recursive: true });
mkdirSync(extractDir, { recursive: true });

try {
  const downloadUrl = `https://github.com/XTLS/Xray-core/releases/latest/download/${target.asset}`;
  if (hasGh()) {
    console.log(`使用 gh 下载 xray：${target.asset}`);
    execFileSync("gh", ["release", "download", "--repo", "XTLS/Xray-core", "--pattern", target.asset, "--dir", tempRoot], {
      stdio: "inherit"
    });
  } else {
    console.log(`下载 xray：${downloadUrl}`);
    execFileSync("curl", ["--http1.1", "-L", downloadUrl, "-o", zipPath], {
      stdio: "inherit"
    });
  }

  execFileSync("unzip", ["-o", zipPath, "-d", extractDir], {
    stdio: "inherit"
  });

  const extractedBinary = path.join(extractDir, "xray");
  const extractedGeoIp = path.join(extractDir, "geoip.dat");
  const extractedGeoSite = path.join(extractDir, "geosite.dat");
  if (!existsSync(extractedBinary)) {
    throw new Error("压缩包里没有 xray 可执行文件");
  }
  if (!existsSync(extractedGeoIp) || !existsSync(extractedGeoSite)) {
    throw new Error("压缩包里没有完整规则数据");
  }

  rmSync(outputBinary, { force: true });
  rmSync(outputGeoIp, { force: true });
  rmSync(outputGeoSite, { force: true });
  renameSync(extractedBinary, outputBinary);
  renameSync(extractedGeoIp, outputGeoIp);
  renameSync(extractedGeoSite, outputGeoSite);
  chmodSync(outputBinary, 0o755);

  console.log(`xray 已安装：${outputBinary}`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

function hasGh() {
  const result = spawnSync("gh", ["--version"], {
    stdio: "ignore"
  });

  return result.status === 0;
}
