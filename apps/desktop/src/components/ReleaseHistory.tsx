import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Loader, Text } from "@mantine/core";
import type { ClientReleaseHistoryItemDto } from "@chordv/shared";
import { fetchReleaseHistory, type ReleaseChannel } from "../api/client";
import { cleanChangelogItem, compareVersion, formatVersionLabel } from "../lib/updateState";
import { APP_BUILD_NUMBER } from "../lib/buildInfo";
import styles from "./UpdateCenterModal.module.css";

type HistoryState =
  | { status: "loading" }
  | { status: "ready"; items: ClientReleaseHistoryItemDto[] }
  | { status: "unsupported" }
  | { status: "failed" };

/** Past releases for this platform, newest first, as shown in the update center. */
export function ReleaseHistory({ channel, appVersion }: { channel: ReleaseChannel; appVersion: string }) {
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const load = useCallback(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchReleaseHistory({ channel })
      .then((items) => { if (!cancelled) setState(items ? { status: "ready", items } : { status: "unsupported" }); })
      .catch(() => { if (!cancelled) setState({ status: "failed" }); });
    return () => { cancelled = true; };
  }, [channel]);
  useEffect(() => load(), [load]);

  if (state.status === "loading") {
    return <div className={styles.historyNotice}><Loader size={16} /><Text size="sm" c="dimmed">正在加载更新日志</Text></div>;
  }
  if (state.status === "unsupported") {
    return <Text size="sm" c="dimmed" className={styles.historyNotice}>服务器暂未提供更新日志，请稍后再试。</Text>;
  }
  if (state.status === "failed") {
    return (
      <div className={styles.historyNotice}>
        <Text size="sm" c="dimmed">更新日志暂时加载不出来，请检查网络后重试。</Text>
        <Button size="compact-sm" variant="light" onClick={() => load()}>重试</Button>
      </div>
    );
  }
  if (state.items.length === 0) {
    return <Text size="sm" c="dimmed" className={styles.historyNotice}>还没有已发布的版本。</Text>;
  }
  return (
    <ol className={styles.history} aria-label="更新日志">
      {state.items.map((item) => {
        const changelog = item.changelog.map(cleanChangelogItem).filter(Boolean);
        // With builds on both sides, only the installed build is the current one.
        const current = compareVersion(item.version, appVersion) === 0
          && (!item.build || !APP_BUILD_NUMBER || item.build === APP_BUILD_NUMBER);
        const title = item.title.trim() && item.title.trim() !== item.version ? item.title.trim() : null;
        return (
          <li key={item.version} className={styles.release}>
            <div className={styles.releaseHead}>
              <Text className={styles.releaseVersion}>{formatVersionLabel(item.version)}</Text>
              {item.build ? <Text size="xs" c="dimmed">构建 {item.build}</Text> : null}
              {item.releaseChannel === "beta" ? <Badge size="sm" variant="light" color="orange">测试版</Badge> : null}
              {current ? <Badge size="sm" variant="light" color="cyan">当前版本</Badge> : null}
              {item.publishedAt ? <Text size="xs" c="dimmed" className={styles.releaseDate}>{formatReleaseDate(item.publishedAt)}</Text> : null}
            </div>
            {title ? <Text size="sm" fw={500} mt={4}>{title}</Text> : null}
            {changelog.length ? (
              <ul className={styles.releaseNotes}>
                {changelog.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
              </ul>
            ) : <Text size="sm" c="dimmed" mt={4}>本次版本未填写更新说明。</Text>}
          </li>
        );
      })}
    </ol>
  );
}

function formatReleaseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}
