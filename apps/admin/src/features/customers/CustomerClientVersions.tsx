import { Text } from "@mantine/core";
import type { AdminUserRecordDto } from "@chordv/shared";
import { formatDateTimeWithYear } from "../../utils/admin-format";
import { formatClientLastSeen, formatClientVersion, formatClientVersionDetail, latestClientVersion, sortClientVersions } from "../../utils/client-versions";
import styles from "./CustomerWorkspace.module.css";

/** 列表里的一行：最近使用的客户端版本与平台，以及最近使用时间。 */
export function ClientVersionBrief({ user, className }: { user: Pick<AdminUserRecordDto, "clientVersions"> | undefined; className?: string }) {
  const latest = latestClientVersion(user);
  if (!latest) return null;
  return <small className={className ?? styles.clientVersion} title={`最近使用 ${formatDateTimeWithYear(latest.lastSeenAt)}`}>
    {formatClientVersion(latest)} · {formatClientLastSeen(latest.lastSeenAt)}
  </small>;
}

/** 账号资料里的完整记录：每个平台一行。 */
export function ClientVersionFacts({ user }: { user: Pick<AdminUserRecordDto, "clientVersions"> }) {
  const entries = sortClientVersions(user.clientVersions);
  if (!entries.length) return <>暂无记录<Text size="xs" c="dimmed" mt={4}>客户端登录后检查更新时会自动记录版本</Text></>;
  return <>{entries.map(entry => <div key={entry.platform} className={styles.clientVersionFact}>
    <span>{formatClientVersionDetail(entry)}</span>
    <Text size="xs" c="dimmed" title={formatDateTimeWithYear(entry.lastSeenAt)}>最近使用 {formatClientLastSeen(entry.lastSeenAt)}</Text>
  </div>)}</>;
}
