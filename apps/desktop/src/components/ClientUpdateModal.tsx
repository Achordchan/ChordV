import type { ReactNode } from "react";
import { Badge, Button, Modal, Text } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import appIcon from "../../src-tauri/icons/icon.png";
import type { ClientUpdateCheckResult } from "../api/client";
import { cleanChangelogItem, compareVersion, formatVersionLabel } from "../lib/updateState";
import { NoticeRow } from "./NoticeRow";
import { APP_BUILD_NUMBER, formatVersionWithBuild } from "../lib/buildInfo";
import styles from "./ClientUpdateModal.module.css";

type ClientUpdateModalProps = {
  opened: boolean;
  update: ClientUpdateCheckResult | null;
  appVersion: string;
  forceRequired: boolean;
  /** 强制更新已下载：自动安装前的剩余秒数；null 表示没有在倒计时。 */
  autoInstallCountdown?: number | null;
  downloadBusy: boolean;
  /** Download progress panel; rendered between the header and the changelog. */
  progress: ReactNode;
  /** Primary action (download / install); the modal only lays it out. */
  primaryAction: ReactNode;
  onClose: () => void;
};

export function ClientUpdateModal(props: ClientUpdateModalProps) {
  const update = props.update;
  const latestVersion = update?.latestVersion ?? props.appVersion;
  // Builds are only worth showing when the version itself does not change.
  const sameVersion = compareVersion(latestVersion, props.appVersion) === 0;
  const belowMinimum = Boolean(update && compareVersion(update.minimumVersion, props.appVersion) > 0);
  const changelog = (update?.changelog ?? []).map(cleanChangelogItem).filter(Boolean);
  const publishedAt = formatPublishedAt(update?.publishedAt ?? null);
  const counting = props.forceRequired && typeof props.autoInstallCountdown === "number";
  const installHint = update?.deliveryMode === "desktop_full_replace" || props.forceRequired
    ? "下载完成后会自动安装并重启。"
    : "下载完成后点击“安装并重启”即可完成更新。";
  return (
    <Modal
      opened={props.opened}
      onClose={props.onClose}
      centered
      size={460}
      radius="lg"
      title={props.forceRequired ? "需要更新" : "发现新版本"}
      withCloseButton={!props.forceRequired}
      closeOnClickOutside={!props.forceRequired}
      closeOnEscape={!props.forceRequired}
      closeButtonProps={{ "aria-label": "关闭版本更新" }}
      classNames={{ title: styles.title, header: styles.header, content: styles.content, body: styles.body }}
    >
      <div className={styles.hero}>
        <img src={appIcon} alt="" className={styles.logo} />
        <div className={styles.heroInfo}>
          <div className={styles.nameRow}>
            <Text className={styles.name}>ChordV {formatVersionLabel(latestVersion)}</Text>
            {update?.releaseChannel === "beta" ? <Badge size="sm" variant="light" color="orange">测试版</Badge> : null}
            {props.forceRequired ? <Badge size="sm" variant="light" color="red">必须更新</Badge> : null}
          </div>
          <div className={styles.versionRow}>
            <span>{formatVersionWithBuild(formatVersionLabel(props.appVersion), sameVersion ? APP_BUILD_NUMBER : null)}</span>
            <IconArrowRight size={13} className={styles.arrow} aria-label="更新至" />
            <span className={styles.versionNext}>{formatVersionWithBuild(formatVersionLabel(latestVersion), sameVersion ? update?.latestBuild : null)}</span>
            {publishedAt ? <span className={styles.published}>{publishedAt} 发布</span> : null}
          </div>
        </div>
      </div>

      {counting ? (
        <NoticeRow tone="danger" role="alert" className={styles.notice}>
          {`必须更新：${props.autoInstallCountdown} 秒后自动安装并重启，期间连接会断开。`}
        </NoticeRow>
      ) : props.forceRequired ? (
        <NoticeRow tone="danger" role="alert" className={styles.notice}>
          {belowMinimum
            ? `当前版本低于最低支持版本 ${formatVersionLabel(update?.minimumVersion ?? "")}，更新后才能继续使用。`
            : "这是一次必要更新，更新后才能继续使用。"}
        </NoticeRow>
      ) : null}

      {props.progress ? <div className={styles.progress}>{props.progress}</div> : null}

      <section className={styles.changelog} aria-labelledby="client-update-changelog">
        <Text id="client-update-changelog" className={styles.sectionTitle}>更新内容</Text>
        {changelog.length ? (
          <ul className={styles.list}>
            {changelog.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}
          </ul>
        ) : (
          <Text size="sm" c="dimmed" mt={6}>本次版本暂未填写更新日志。</Text>
        )}
      </section>

      <div className={styles.footer}>
        <Text size="xs" c="dimmed" className={styles.hint}>{installHint}</Text>
        <div className={styles.actions}>
          {!props.forceRequired ? (
            <Button variant="default" disabled={props.downloadBusy} onClick={props.onClose}>稍后再说</Button>
          ) : null}
          {props.primaryAction}
        </div>
      </div>
    </Modal>
  );
}

function formatPublishedAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}
