import { useEffect, useState } from "react";
import { Badge, Button, Loader, Text } from "@mantine/core";
import type { ClientReleaseHistoryItemDto } from "@chordv/shared";
import type { ReleaseChannel } from "../api/client";
import { fetchGitHubReleaseHistory } from "../lib/githubReleases";
import { GITHUB_RELEASE_NOT_CONFIGURED, GitHubReleaseConfigurationError } from "../lib/githubReleaseSource";
import { cleanChangelogItem, compareVersion, formatVersionLabel } from "../lib/updateState";
import { APP_BUILD_NUMBER } from "../lib/buildInfo";
import styles from "./UpdateCenterModal.module.css";

type HistoryState =
  | { status: "loading" }
  | { status: "ready"; items: ClientReleaseHistoryItemDto[]; hasMore: boolean }
  | { status: "unconfigured" }
  | { status: "failed" };

/** Past releases for this platform, newest first, as shown in the update center. */
export function ReleaseHistory({ channel, appVersion }: { channel: ReleaseChannel; appVersion: string }) {
  return <ChannelHistory key={channel} channel={channel} appVersion={appVersion} />;
}

function ChannelHistory({ channel, appVersion }: { channel: ReleaseChannel; appVersion: string }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetchGitHubReleaseHistory({ channel, page })
      .then((result) => { if (!cancelled) setState({ status: "ready", ...result }); })
      .catch((reason) => { if (!cancelled) setState({ status: reason instanceof GitHubReleaseConfigurationError ? "unconfigured" : "failed" }); });
    return () => { cancelled = true; };
  }, [channel, page, reloadKey]);

  if (state.status === "loading") {
    return <div className={styles.historyNotice}><Loader size={16} /><Text size="sm" c="dimmed">正在加载更新日志</Text></div>;
  }
  if (state.status === "unconfigured") {
    return <Text size="sm" c="dimmed" className={styles.historyNotice}>{GITHUB_RELEASE_NOT_CONFIGURED}</Text>;
  }
  if (state.status === "failed") {
    return (
      <div className={styles.historyNotice}>
        <Text size="sm" c="dimmed">更新日志暂时加载不出来，请检查网络后重试。</Text>
        {page > 1 && <Button size="compact-sm" variant="subtle" onClick={() => setPage(page - 1)}>上一页</Button>}
        <Button size="compact-sm" variant="light" onClick={() => setReloadKey((value) => value + 1)}>重试</Button>
      </div>
    );
  }
  return (<>
    {!state.items.length ? <Text size="sm" c="dimmed" className={styles.historyNotice}>{page === 1 && !state.hasMore ? "还没有已发布的版本。" : "本页没有此渠道的桌面版本。"}</Text> : <ol className={styles.history} aria-label="更新日志">
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
    </ol>}
    {(page > 1 || state.hasMore) && <nav className={styles.footer} aria-label="更新日志分页">
      {page > 1 && <Button size="compact-sm" variant="light" onClick={() => setPage(page - 1)}>上一页</Button>}
      {state.hasMore && <Button size="compact-sm" variant="light" onClick={() => setPage(page + 1)}>下一页</Button>}
    </nav>}
  </>);
}

function formatReleaseDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}
