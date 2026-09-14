import { BadRequestException, Injectable } from "@nestjs/common";
import type { SiteAddressConfigDto, UpdateSiteAddressConfigDto } from "@chordv/shared";
import { PrismaService } from "./prisma.service";

export const SITE_ADDRESS_KEY = "site-address";
export function normalizeSiteOrigin(value: string, allowLoopback = false): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new BadRequestException("请填写完整的 HTTPS 站点地址"); }
  const localHttp = allowLoopback && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!localHttp && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new BadRequestException("站点地址必须为 HTTPS 域名，不得包含账号、路径、查询参数或片段");
  }
  return url.origin;
}

@Injectable()
export class SiteAddressService {
  constructor(private readonly prisma: PrismaService) {}
  async get(): Promise<SiteAddressConfigDto> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: SITE_ADDRESS_KEY } });
    if (row) {
      const value = row.value as unknown as UpdateSiteAddressConfigDto;
      return { primaryOrigin: value.primaryOrigin, legacyOrigins: value.legacyOrigins, updatedAt: row.updatedAt.toISOString() };
    }
    const primaryOrigin = normalizeSiteOrigin(process.env.CHORDV_PUBLIC_BASE_URL?.trim() || "https://v.achord.cn", true);
    return { primaryOrigin, legacyOrigins: ["https://v.baymaxgroup.com"].filter(origin=>origin!==primaryOrigin), updatedAt: null };
  }
  async save(input: UpdateSiteAddressConfigDto): Promise<SiteAddressConfigDto> {
    const primaryOrigin = normalizeSiteOrigin(input.primaryOrigin);
    const legacyOrigins = [...new Set(input.legacyOrigins.map(origin => normalizeSiteOrigin(origin)))].filter(origin => origin !== primaryOrigin);
    const value = { primaryOrigin, legacyOrigins };
    const row = await this.prisma.systemSetting.upsert({where:{key:SITE_ADDRESS_KEY},create:{key:SITE_ADDRESS_KEY,value},update:{value}});
    return { ...value, updatedAt: row.updatedAt.toISOString() };
  }
}
