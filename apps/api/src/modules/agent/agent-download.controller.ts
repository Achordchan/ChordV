import { BadRequestException, Controller, Get, GoneException, NotFoundException, ServiceUnavailableException, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { agentReleaseRoot, loadGoRelease } from "./agent-go-release";

/** Downloads are pinned to this running backend's bundled Go release. */
@Controller()
export class AgentDownloadController {
  @Get("agent-download/go/:version/:arch")
  async downloadGo(@Param("version") version: string, @Param("arch") arch: string, @Res() response: Response) {
    if (arch !== "amd64" && arch !== "arm64") throw new BadRequestException("不支持的架构");
    const release = loadGoRelease();
    if (version !== release.version) throw new NotFoundException("安装命令对应的后台版本已改变，请重新生成命令");
    await sendArtifact(path.join(agentReleaseRoot(), "agent-go-dist", `chordv-agent-linux-${arch}`),
      "application/octet-stream", `Go agent（${arch}）`, response);
  }

  // Previously copied Node/Xray commands must fail before fetching executable
  // content. Existing VPS services and their files are not removed or stopped.
  @Get(["agent-download/:arch", "agent-download/node/:name", "agent-download/xray/:name"])
  retiredInstaller() {
    throw new GoneException("旧 Node/Xray 安装入口已停用，请在后台重新生成 Go agent 接入命令");
  }
}

export async function sendArtifact(file: string, contentType: string, label: string, response: Response) {
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
