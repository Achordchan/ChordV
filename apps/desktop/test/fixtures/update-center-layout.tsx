import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, createTheme, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../src/styles.css";
import { UpdateCenterModal } from "../../src/components/UpdateCenterModal";
import { ClientUpdateModal } from "../../src/components/ClientUpdateModal";
import { ClientUpdateProgressPanel } from "../../src/components/ClientUpdateProgressPanel";
import type { ClientUpdateCheckResult } from "../../src/api/client";
import type { UpdateDownloadState } from "../../src/lib/updateState";
import { createDefaultUpdateCenterItems, type UpdateCenterState } from "../../src/lib/updateCenter";

// 仅由布局回归的临时 Vite 服务加载，不进入生产入口或生产构建。
const theme = createTheme({
  primaryColor: "cyan",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
  radius: { xs: "4px", sm: "6px", md: "8px", lg: "12px", xl: "14px" },
  defaultRadius: "md"
});

function LayoutFixture() {
  const [checks, setChecks] = useState(0);
  const [beta, setBeta] = useState(false);
  const [autoDownload, setAutoDownload] = useState(true);
  const [installBusy, setInstallBusy] = useState(false);
  const [installs, setInstalls] = useState(0);
  const [closes, setCloses] = useState(0);
  const [componentUpdates, setComponentUpdates] = useState(0);
  const params = new URLSearchParams(location.search);
  const status = params.get("status");
  const current = status === "current";
  const surface = params.get("surface") ?? "center";
  const install = () => { setInstalls(value => value + 1); setInstallBusy(true); };
  useEffect(() => {
    const release = () => setInstallBusy(false);
    window.addEventListener("test-only-install-failed", release);
    return () => window.removeEventListener("test-only-install-failed", release);
  }, []);
  const update: ClientUpdateCheckResult = {
    platform: "macos", channel: "stable", currentVersion: "1.1.12", latestVersion: "2.0.0",
    minimumVersion: "0.0.0", hasUpdate: true, forceUpgrade: false, title: "发现新版本",
    changelog: ["修复更新交接。"], publishedAt: null, deliveryMode: "desktop_installer_download",
    downloadUrl: null, artifact: null
  };
  const download: UpdateDownloadState = {
    phase: "completed", fileName: "test-only.dmg", downloadedBytes: 100, totalBytes: 100,
    localPath: "/test-only/never-installed.dmg", message: "更新包已校验。"
  };
  const progress = <ClientUpdateProgressPanel state={download} installBusy={installBusy} onRetry={() => {}} onInstall={install} />;
  const state: UpdateCenterState = {
    opened: true, checking: status === "checking", updatingKey: null, lastCheckedAt: current ? Date.UTC(2026, 10, 18) : null,
    items: createDefaultUpdateCenterItems().map(item => ({
      ...item, status: current ? "current" : status === "checking" || status === "idle" || status === "unsupported" ? status : "failed", localVersion: current ? "1.1.12" : null,
      remoteVersion: current ? "1.1.12" : null,
      message: "尚未配置 GitHub 发布仓库，本地版本未接入在线更新。\n请在完成发布配置后重新检查组件。"
    }))
  };
  return <MantineProvider theme={theme} defaultColorScheme="light">
    <output data-testid="check-count">{checks}</output>
    <output data-testid="install-count">{installs}</output>
    <output data-testid="close-count">{closes}</output>
    <output data-testid="component-update-count">{componentUpdates}</output>
    {surface === "client" ? <ClientUpdateModal opened update={update} appVersion="1.1.12" forceRequired={false}
      platform="macos" downloadBusy={false} installBusy={installBusy} progress={progress}
      primaryAction={<Button loading={installBusy} disabled={installBusy} onClick={install}>安装并重启</Button>}
      onClose={() => setCloses(value => value + 1)} /> : surface === "progress" ? progress : (
    <UpdateCenterModal state={state} appVersion="1.1.12" busy={false} installBusy={installBusy} runtimeBusy={false}
      runtimeInUse={false} syncDeferred={false} syncError={current ? null : "组件暂未同步，可在更新中心查看原因并重试。"}
      betaChannel={beta} onBetaChannelChange={setBeta} autoDownload={autoDownload} onAutoDownloadChange={setAutoDownload}
      appReady={params.get("ready") === "1"} onInstallApp={install}
      onClose={() => setCloses(value => value + 1)} onCheckOnly={() => setChecks(value => value + 1)}
      onUpdateOne={() => setComponentUpdates(value => value + 1)} />)}
  </MantineProvider>;
}

createRoot(document.getElementById("root")!).render(<LayoutFixture />);
