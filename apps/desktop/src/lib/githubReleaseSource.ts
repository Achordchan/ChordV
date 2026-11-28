import { assertReleaseNotReplayed, normalizeReleaseRepository, parseReleaseManifest, type GitHubReleaseManifest, type ReleaseChannel } from "./githubReleaseManifest";

export const BUILTIN_GITHUB_MIRRORS = Object.freeze(["https://ghfast.top/"]);
export const GITHUB_RELEASE_NOT_CONFIGURED = "尚未配置 GitHub 发布仓库，本地版本未接入在线更新。";
export class GitHubReleaseConfigurationError extends Error {}
export type GitHubReleaseConfiguration = { repository: string; publicKey: string };
export type ReleaseTextResponse = { status: number; body: string };
export type ReleaseTransport = {
  read: (url: string) => Promise<ReleaseTextResponse>;
  verify: (input: { manifest: string; signature: string; publicKey: string }) => Promise<boolean>;
  authorize?: (input: { manifest: string; signature?: string; tag: string }) => Promise<unknown>;
  readHighest?: (key: string) => { version: string; build: number } | null;
  writeHighest?: (key: string, value: { version: string; build: number }) => void;
};

export function githubTransportUrls(origin: string, configuration: GitHubReleaseConfiguration) {
  const parsed = new URL(origin);
  const repository = normalizeReleaseRepository(configuration.repository);
  const prefix = parsed.hostname === "github.com" ? `/${repository}/releases/download/` : `/${repository}/release-channels/`;
  if (parsed.protocol !== "https:" || !["github.com", "raw.githubusercontent.com"].includes(parsed.hostname)
      || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !parsed.pathname.startsWith(prefix)) {
    throw new Error("更新地址不是已配置仓库的有效 GitHub 源。");
  }
  // 固定公钥认证发布者，镜像只传输同一份已签清单和已授权资产。
  const mirrors = configuration.publicKey ? BUILTIN_GITHUB_MIRRORS : [];
  return [...mirrors.map(prefix => `${prefix}${origin}`), origin];
}

export class ReleaseChannelNotPublishedError extends Error {}

export class GitHubReleaseSource {
  private cache = new Map<string, { at: number; value: GitHubReleaseManifest }>();
  private pending = new Map<string, Promise<GitHubReleaseManifest>>();
  constructor(private configuration: GitHubReleaseConfiguration, private transport: ReleaseTransport) {
    this.configuration = { repository: normalizeReleaseRepository(configuration.repository), publicKey: configuration.publicKey };
  }

  async load(channel: ReleaseChannel, force = false): Promise<GitHubReleaseManifest> {
    const cached = this.cache.get(channel);
    if (!force && cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
    const existing = this.pending.get(channel);
    if (existing) return existing;
    const task = this.loadChannel(channel).finally(() => this.pending.delete(channel));
    this.pending.set(channel, task);
    return task;
  }

  private async loadChannel(channel: ReleaseChannel) {
    const origin = `https://raw.githubusercontent.com/${this.configuration.repository}/release-channels/${channel}.json`;
    let error: unknown = new Error("GitHub 发布清单读取失败。");
    let originMissing = false;
    for (const url of githubTransportUrls(origin, this.configuration)) {
      // 指针更新与CDN缓存可能让JSON/.sig暂时不一致；同源有界重读，不混用镜像、不跳过验签。
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await this.transport.read(url);
          if (response.status === 404) { if (url === origin) originMissing = true; break; }
          if (response.status !== 200) throw new Error(`GitHub 发布清单请求失败（${response.status}）。`);
          let verifiedSignature: string | undefined;
          if (this.configuration.publicKey) {
            const signature = await this.transport.read(`${url}.sig`);
            if (signature.status !== 200 || !await this.transport.verify({ manifest: response.body, signature: signature.body.trim(), publicKey: this.configuration.publicKey })) {
              throw new Error("GitHub 发布清单签名校验失败。");
            }
            verifiedSignature = signature.body;
          }
          const manifest = parseReleaseManifest(response.body, channel);
          if (manifest.schemaVersion === 2) {
            if (!this.configuration.publicKey) throw new Error("新发布绑定模式必须配置固定验签公钥。");
            if (manifest.tagBinding?.mode !== "signed-manifest-tree" || manifest.tagBinding.repository !== this.configuration.repository.toLowerCase()) throw new Error("已签发布仓库与配置仓库不一致。");
            if (!this.transport.authorize) throw new Error("新发布模式需要原生绑定授权。");
          }
          // 版本真相始终位于该仓库固定标签下；渠道指针不能独立虚构一个发布。
          const canonicalOrigin = `https://github.com/${this.configuration.repository}/releases/download/${encodeURIComponent(manifest.tag)}/chordv-release.json`;
          const prefix = url.slice(0, url.length - origin.length);
          const canonical = await this.transport.read(`${prefix}${canonicalOrigin}`);
          if (canonical.status !== 200 || canonical.body !== response.body) throw new Error("GitHub 渠道清单与正式发布资产不一致。");
          if (manifest.schemaVersion === 2) {
            const canonicalSignature = await this.transport.read(`${prefix}${canonicalOrigin}.sig`);
            if (canonicalSignature.status !== 200 || canonicalSignature.body !== verifiedSignature) throw new Error("GitHub 渠道签名与正式发布签名原文不一致。");
          }
          const highestKey = `chordv.github.highest:${this.configuration.repository}:${channel}`;
          assertReleaseNotReplayed(manifest, this.transport.readHighest?.(highestKey) ?? null);
          await this.transport.authorize?.({ manifest: response.body, signature: verifiedSignature, tag: manifest.tag });
          this.transport.writeHighest?.(highestKey, { version: manifest.version, build: manifest.build });
          this.cache.set(channel, { at: Date.now(), value: manifest });
          return manifest;
        } catch (reason) { error = reason; }
      }
    }
    if (originMissing) throw new ReleaseChannelNotPublishedError("GitHub 尚未发布此渠道的版本。");
    throw error;
  }
}
