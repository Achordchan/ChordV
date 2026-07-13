import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type {
  AdminDownloadMirrorConfigDto,
  UpdateAdminDownloadMirrorConfigInputDto
} from "@chordv/shared";
import { PrismaService } from "./prisma.service";
import { throwLocalReadAsServiceUnavailable, throwLocalSaveAsServiceUnavailable } from "./prisma-error.utils";

export const DOWNLOAD_MIRROR_SETTING_KEY = "download-mirror";

type StoredDownloadMirrorConfig = {
  defaultMirrorPrefix?: string | null;
  allowClientMirror?: boolean;
};

export type EffectiveDownloadMirrorConfig = {
  defaultMirrorPrefix: string | null;
  allowClientMirror: boolean;
  updatedAt: Date | null;
};

@Injectable()
export class DownloadMirrorService {
  private readonly logger = new Logger(DownloadMirrorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAdminConfig(): Promise<AdminDownloadMirrorConfigDto> {
    const config = await this.loadEffectiveConfig();
    return {
      defaultMirrorPrefix: config.defaultMirrorPrefix,
      allowClientMirror: config.allowClientMirror,
      updatedAt: config.updatedAt ? config.updatedAt.toISOString() : null
    };
  }

  async updateAdminConfig(input: UpdateAdminDownloadMirrorConfigInputDto): Promise<AdminDownloadMirrorConfigDto> {
    const current = await this.loadEffectiveConfig();
    const nextPrefix =
      input.defaultMirrorPrefix !== undefined
        ? normalizeMirrorPrefixList(input.defaultMirrorPrefix)
        : current.defaultMirrorPrefix;
    const nextAllow =
      input.allowClientMirror !== undefined ? Boolean(input.allowClientMirror) : current.allowClientMirror;

    if (nextPrefix) {
      for (const item of nextPrefix.split("\n")) {
        const prefix = item.trim();
        if (!prefix) continue;
        if (prefix.includes("{url}")) {
          const sample = prefix.replaceAll("{url}", "https://example.com/file.dat");
          if (!/^https?:\/\//i.test(sample)) {
            throw new BadRequestException("加速镜像模板必须生成有效的 http/https 地址。");
          }
          continue;
        }
        if (!/^https?:\/\//i.test(prefix)) {
          throw new BadRequestException("加速镜像前缀必须是完整的 http/https 地址。");
        }
      }
    }

    try {
      const saved = await this.prisma.systemSetting.upsert({
        where: { key: DOWNLOAD_MIRROR_SETTING_KEY },
        create: {
          key: DOWNLOAD_MIRROR_SETTING_KEY,
          value: {
            defaultMirrorPrefix: nextPrefix,
            allowClientMirror: nextAllow
          }
        },
        update: {
          value: {
            defaultMirrorPrefix: nextPrefix,
            allowClientMirror: nextAllow
          }
        }
      });
      return {
        defaultMirrorPrefix: nextPrefix,
        allowClientMirror: nextAllow,
        updatedAt: saved.updatedAt.toISOString()
      };
    } catch (error) {
      throwLocalSaveAsServiceUnavailable(error, "保存加速镜像配置失败。");
    }
  }

  async getEffectiveConfig(): Promise<EffectiveDownloadMirrorConfig> {
    return this.loadEffectiveConfig();
  }

  private async loadEffectiveConfig(): Promise<EffectiveDownloadMirrorConfig> {
    try {
      const row = await this.prisma.systemSetting.findUnique({
        where: { key: DOWNLOAD_MIRROR_SETTING_KEY }
      });
      const value = (row?.value ?? {}) as StoredDownloadMirrorConfig;
      return {
        defaultMirrorPrefix: normalizeMirrorPrefixList(value.defaultMirrorPrefix),
        allowClientMirror: value.allowClientMirror !== false,
        updatedAt: row?.updatedAt ?? null
      };
    } catch (error) {
      this.logger.warn(`读取加速镜像配置失败，回退默认值：${error instanceof Error ? error.message : String(error)}`);
      try {
        throwLocalReadAsServiceUnavailable(error, "读取加速镜像配置失败。");
      } catch {
        return {
          defaultMirrorPrefix: null,
          allowClientMirror: true,
          updatedAt: null
        };
      }
      return {
        defaultMirrorPrefix: null,
        allowClientMirror: true,
        updatedAt: null
      };
    }
  }
}

export function normalizeMirrorPrefixList(value: string | null | undefined) {
  if (!value) return null;
  const items = value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) return null;
  return items.join("\n");
}
