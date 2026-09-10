import { Body, Controller, Headers, HttpCode, Post, Res } from "@nestjs/common";
import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import type { Response } from "express";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { AgentRegisterService } from "./agent-register.service";
import { agentReleaseRoot, loadGoRelease, type GoRelease } from "./agent-go-release";
import { normalizePanelInbound, type PanelInboundSpec } from "./panel-inbound";

class InstallScriptRequestDto {
  @IsString() @IsNotEmpty() @MaxLength(128) token!: string;
}

@Controller()
export class AgentInstallController {
  constructor(private readonly registerService: AgentRegisterService) {}

  @Post("agent-install/script.sh")
  @HttpCode(200)
  async installScript(@Body() body: InstallScriptRequestDto,
    @Headers("x-forwarded-proto") proto: string | undefined,
    @Headers("host") host: string | undefined, @Res() response: Response) {
    response.setHeader("content-type", "text/x-shellscript; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    try {
      const token = await this.registerService.resolveTokenNode(body.token);
      if (!token) throw new Error("安装令牌不存在，请重新生成命令");
      if (!token.spec) this.registerService.requireOnboardingSpec();
      const configured = process.env.CHORDV_PUBLIC_BASE_URL?.trim();
      const origin = normalizeOrigin(configured || (host ? (proto?.split(",")[0]?.trim() || "http") + "://" + host : ""));
      response.status(200).end(renderInstallScript({ token: body.token, apiBase: origin,
        nodeId: token.nodeId, usable: token.usable, spec: token.spec!, release: loadGoRelease() }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法生成安装命令";
      response.status(200).end("#!/usr/bin/env bash\nprintf '%s\\n' " + shellLiteral("安装中止：" + message) + " >&2\nexit 1\n");
    }
  }
}

export function normalizeOrigin(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw || raw.length > 253) return "";
  let url: URL;
  try { url = new URL(raw); } catch { return ""; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (url.username || url.password || url.search || url.hash) return "";
  if (url.pathname !== "/" && url.pathname !== "") return "";
  // url.host is already parsed/normalized; this rejects anything (e.g. an IPv6
  // literal's brackets aside) that is not a plain hostname/IP plus port.
  if (!/^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(url.host)) return "";
  if (url.port && Number(url.port) > 65535) return "";
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) return "";
  return `${url.protocol}//${url.host}`;
}


function shellLiteral(value: string) { return "'" + value.replace(/'/g, "'\\''") + "'"; }

export function renderInstallScript(input: { token: string; apiBase: string; nodeId: string;
  usable: boolean; spec: PanelInboundSpec; release: GoRelease }) {
  const origin = normalizeOrigin(input.apiBase);
  if (!origin) throw new Error("安装脚本的公网地址无效");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.token)) throw new Error("安装脚本的注册令牌格式无效");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.nodeId)) throw new Error("节点 ID 无效");
  const spec = normalizePanelInbound(input.spec as unknown as Record<string, unknown>);
  const values: Record<string, string> = {
    ORIGIN: origin, TOKEN: input.token, NODE_ID: input.nodeId, USABLE: input.usable ? "1" : "0",
    TOKEN_HASH: createHash("sha256").update(input.token).digest("hex"),
    SPEC: JSON.stringify(spec), VERSION: input.release.version,
    AMD64_SHA: input.release.sha256.amd64, ARM64_SHA: input.release.sha256.arm64
  };
  const template = readFileSync(path.join(agentReleaseRoot(), "scripts/install-go-agent.sh"), "utf8");
  return template.replace(/@@([A-Z0-9_]+)@@/g, (_, key: string) => {
    if (!(key in values)) throw new Error("安装模板参数缺失");
    return shellLiteral(values[key]);
  });
}
