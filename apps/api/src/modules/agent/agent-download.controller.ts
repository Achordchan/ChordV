import { BadRequestException, Controller, Get, NotFoundException, ServiceUnavailableException, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { pipeline } from "node:stream/promises";

/**
 * Serves the node-agent release tarball for the install script. The tarball is
 * provisioned on the API host (a volume path named by CHORDV_AGENT_DIST_DIR, e.g.
 * /app/agent-dist/chordv-agent-linux-x64.tar.gz) — no build-time bundling, so an
 * agent update is a file drop plus this route, independent of API releases.
 * Public by design: the install command runs on a fresh VPS with no credentials;
 * the artifact is not secret (its integrity matters, and the tarball layout is
 * validated by the install script).
 *
 * The Xray binary is served the same way and for the same reason: the installer
 * only trusts this origin, so adding a second download host would widen the
 * trust set and make installs depend on that host's reachability.
 */
const ALLOWED_ARCHES = new Set(["linux-x64", "linux-arm64"]);

@Controller()
export class AgentDownloadController {
  @Get("agent-download/node/:name")
  async downloadNode(@Param("name") name: string, @Res() response: Response) {
    const digest = name.endsWith(".sha256");
    const arch = digest ? name.slice(0, -".sha256".length) : name;
    if (!ALLOWED_ARCHES.has(arch)) throw new BadRequestException("不支持的架构。");
    const distDir = process.env.CHORDV_AGENT_DIST_DIR?.trim();
    if (!distDir) throw new NotFoundException("该服务器未配置 Node 运行环境分发。");
    const path = await import("node:path");
    await sendArtifact(path.join(distDir, `node-20.19.0-${arch}.tar.gz${digest ? ".sha256" : ""}`),
      digest ? "text/plain; charset=utf-8" : "application/gzip", `Node 运行环境（${arch}）`, response);
  }

  @Get("agent-download/:arch")
  async download(@Param("arch") arch: string, @Res() response: Response) {
    if (!ALLOWED_ARCHES.has(arch)) throw new BadRequestException("不支持的架构。");
    const distDir = process.env.CHORDV_AGENT_DIST_DIR?.trim();
    if (!distDir) {
      throw new NotFoundException("该服务器未配置 Agent 安装包分发（CHORDV_AGENT_DIST_DIR）。");
    }
    const path = await import("node:path");
    await sendArtifact(path.join(distDir, `chordv-agent-${arch}.tar.gz`), "application/gzip", `Agent 安装包（${arch}）`, response);
  }

  /**
   * `:name` is `<arch>` for the tarball and `<arch>.sha256` for its digest — one
   * route so both can never diverge on lookup rules, with the arch allowlisted
   * either way so nothing user-supplied reaches the filename.
   */
  @Get("agent-download/xray/:name")
  async downloadXray(@Param("name") name: string, @Res() response: Response) {
    const digest = name.endsWith(".sha256");
    const arch = digest ? name.slice(0, -".sha256".length) : name;
    if (!ALLOWED_ARCHES.has(arch)) throw new BadRequestException("不支持的架构。");
    const distDir = process.env.CHORDV_XRAY_DIST_DIR?.trim();
    // Explicitly unconfigured is an error in its own right: falling back to some
    // other download source would quietly widen what an install trusts.
    if (!distDir) {
      throw new NotFoundException("该服务器未配置 Xray 分发（CHORDV_XRAY_DIST_DIR）。");
    }
    const path = await import("node:path");
    const file = path.join(distDir, `xray-${arch}.tar.gz${digest ? ".sha256" : ""}`);
    await sendArtifact(file, digest ? "text/plain; charset=utf-8" : "application/gzip", `Xray 安装包（${arch}）`, response);
  }
}

async function sendArtifact(file: string, contentType: string, label: string, response: Response) {
  const fs = await import("node:fs");
  if (typeof fs.constants.O_NOFOLLOW !== "number") {
    throw new ServiceUnavailableException("当前平台不支持安全读取安装包。");
  }
  // Open once without following the artifact symlink. Stat and stream the same
  // descriptor so an atomic publisher replacement cannot change what is served.
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    .catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ELOOP", "ENOTDIR", "EACCES"].includes(error.code ?? "")) {
        throw new NotFoundException(`${label}不可用。`);
      }
      throw error;
    });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new NotFoundException("安装包必须为普通文件。");
    response.setHeader("content-type", contentType);
    response.setHeader("content-length", stat.size);
    response.setHeader("cache-control", "no-store");
    try {
      await pipeline(handle.createReadStream({ autoClose: false }), response);
    } catch (error) {
      if (response.destroyed && (error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE") return;
      throw error;
    }
  } finally { await handle.close(); }
}
