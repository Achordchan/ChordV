import { BadRequestException, Controller, Get, NotFoundException, Param, Res } from "@nestjs/common";
import type { Response } from "express";

/**
 * Serves the node-agent release tarball for the install script. The tarball is
 * provisioned on the API host (a volume path named by CHORDV_AGENT_DIST_DIR, e.g.
 * /app/agent-dist/chordv-agent-linux-x64.tar.gz) — no build-time bundling, so an
 * agent update is a file drop plus this route, independent of API releases.
 * Public by design: the install command runs on a fresh VPS with no credentials;
 * the artifact is not secret (its integrity matters, and the tarball layout is
 * validated by the install script).
 */
const ALLOWED_ARCHES = new Set(["linux-x64", "linux-arm64"]);

@Controller()
export class AgentDownloadController {
  @Get("agent-download/:arch")
  async download(@Param("arch") arch: string, @Res() response: Response) {
    if (!ALLOWED_ARCHES.has(arch)) throw new BadRequestException("不支持的架构。");
    const distDir = process.env.CHORDV_AGENT_DIST_DIR?.trim();
    if (!distDir) {
      throw new NotFoundException("该服务器未配置 Agent 安装包分发（CHORDV_AGENT_DIST_DIR）。");
    }
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Explicit filename assembly (no user input beyond the allowlisted arch).
    const file = path.join(distDir, `chordv-agent-${arch}.tar.gz`);
    if (!fs.existsSync(file)) {
      throw new NotFoundException(`Agent 安装包（${arch}）尚未部署到该服务器。`);
    }
    const stat = await fs.promises.stat(file);
    response.setHeader("content-type", "application/gzip");
    response.setHeader("content-length", stat.size);
    response.setHeader("cache-control", "no-store");
    // Streaming beats readFileSync for an ~80MB artifact behind a single
    // process. pipe+destroy-on-close: an aborted client download must not leak
    // a paused source stream with an open descriptor — repeated unauthenticated
    // aborts could otherwise exhaust the process.
    const stream = fs.createReadStream(file);
    stream.pipe(response);
    const cleanup = () => {
      response.removeListener("close", cleanup);
      response.removeListener("finish", cleanup);
      if (!stream.destroyed && !stream.readableEnded) stream.destroy();
    };
    response.once("close", cleanup);
    response.once("finish", cleanup);
    await new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      response.on("finish", resolve);
    });
  }
}
