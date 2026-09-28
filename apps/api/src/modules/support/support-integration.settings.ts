import type { AchordConnectCredentials } from "./achord-connect";

/** “工单系统接入”设置存放在 SystemSetting 的这一行里（与图床 Token 相同，按原样保存，永不返回给浏览器）。 */
export const SUPPORT_INTEGRATION_SETTING_KEY = "achord-connect";

export type StoredSupportIntegrationConfig = {
  baseUrl: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  enabled: boolean;
  /** 连接代次：地址或 Client ID 每变化一次加一。Webhook 与校准写入时核对代次，旧连接的数据不会写进新连接的状态。 */
  generation: number;
  /** 推送代次：切换连接或启用状态变化时加一。之前的写入结果若在这之后才推送，一律丢弃。 */
  epoch: number;
};

type SystemSettingReader = {
  systemSetting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: unknown; updatedAt: Date } | null>;
  };
};

export function parseStoredSupportIntegrationConfig(value: unknown): StoredSupportIntegrationConfig {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === "string" && record[key] ? (record[key] as string) : null);
  return {
    baseUrl: text("baseUrl"),
    clientId: text("clientId"),
    clientSecret: text("clientSecret"),
    webhookSecret: text("webhookSecret"),
    enabled: record.enabled === true,
    generation: readCounter(record.generation),
    epoch: readCounter(record.epoch)
  };
}

function readCounter(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

export function readSupportIntegrationCredentials(value: StoredSupportIntegrationConfig): AchordConnectCredentials | null {
  return value.baseUrl && value.clientId && value.clientSecret
    ? { baseUrl: value.baseUrl, clientId: value.clientId, clientSecret: value.clientSecret }
    : null;
}

export async function readSupportIntegrationConfig(prisma: SystemSettingReader) {
  const row = await prisma.systemSetting.findUnique({ where: { key: SUPPORT_INTEGRATION_SETTING_KEY } });
  return { value: parseStoredSupportIntegrationConfig(row?.value), updatedAt: row?.updatedAt ?? null };
}

/**
 * 新工单系统是否已启用（开关打开，地址、凭据和 Webhook Secret 齐全）。
 * 客户端不会定时查询状态，未读提醒依赖 Webhook，所以没有 Webhook Secret 不能算启用。
 * 旧自建工单以它为切换点：未启用前旧工单照常可写，启用后旧工单转为只读。
 * 这样后台可以先上线，等新版客户端发布、Achord Connect 配好后再一键切换。
 */
export async function isSupportIntegrationEnabled(prisma: SystemSettingReader) {
  const { value } = await readSupportIntegrationConfig(prisma);
  return isStoredSupportIntegrationEnabled(value);
}

export function isStoredSupportIntegrationEnabled(value: StoredSupportIntegrationConfig) {
  return value.enabled && readSupportIntegrationCredentials(value) !== null && Boolean(value.webhookSecret);
}

type SharedSettingLocker = { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> };

/**
 * 在当前事务里对设置行加共享锁并读取设置。Webhook 与校准的写入都先拿这把锁，保存设置时拿排他锁：
 * 切换连接与这些写入互斥，且所有路径都按“设置行 → 用户未读状态 → 按请求记录”的顺序加锁，不会互相死锁。
 */
export async function lockSupportIntegrationConfigShared(tx: SharedSettingLocker) {
  const rows = await tx.$queryRaw<Array<{ value: unknown }>>`SELECT "value" FROM "SystemSetting" WHERE "key" = ${SUPPORT_INTEGRATION_SETTING_KEY} FOR SHARE`;
  return parseStoredSupportIntegrationConfig(rows[0]?.value);
}
