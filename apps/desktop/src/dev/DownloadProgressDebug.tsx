/** Development-only UI. Imported only behind import.meta.env.DEV; never touches real download state or APIs. */
import { useEffect, useRef, useState } from "react";
import { Button, Group, Select, Slider, Stack, Text } from "@mantine/core";
import { IconAdjustments, IconX } from "@tabler/icons-react";
import { ClientUpdateProgressPanel } from "../components/ClientUpdateProgressPanel";
import type { UpdateDownloadState } from "../lib/updateState";
import { RuntimeAssetsBanner } from "../components/RuntimeAssetsBanner";
import { createIdleRuntimeAssetsState, type RuntimeAssetsUiState } from "../lib/runtimeComponents";
import styles from "./DownloadProgressDebug.module.css";
import { simulateDownload } from "./simulateDownload";

const total = 18.8 * 1024 ** 2;
function example(): RuntimeAssetsUiState {
  return { ...createIdleRuntimeAssetsState(), phase: "downloading", currentComponent: "xray", fileName: "Xray-macos-arm64-v8a.zip", downloadedBytes: 14.8 * 1024 ** 2, totalBytes: total };
}
type Scenario = "checking" | "downloading" | "unknown" | "processing" | "failed" | "cancelled" | "completed";
export function DownloadProgressDebug({ standalone = false, realDownloadVisible = false }: { standalone?: boolean; realDownloadVisible?: boolean }) {
  const [target, setTarget] = useState("xray");
  const [installSimulated, setInstallSimulated] = useState(false);
  const [opened, setOpened] = useState(standalone);
  const [visible, setVisible] = useState(standalone);
  const [state, setState] = useState<RuntimeAssetsUiState>(example);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState("15");
  const [playbackId, setPlaybackId] = useState(0);
  const cancelPlayback = useRef<(() => void) | null>(null);
  const fraction = useRef(14.8 / 18.8);
  const unknown = useRef(false);
  const stop = () => { cancelPlayback.current?.(); cancelPlayback.current = null; setRunning(false); };
  useEffect(() => {
    if (!running) return;
    const cancel = simulateDownload(Number(duration) * 1000, fraction.current, progress => {
      fraction.current = progress;
      // Capture this tick's immutable value, not a ref that may change before React applies it.
      setState(current => ({ ...current, downloadedBytes: progress * total, phase: progress >= 1 ? "completed" : "downloading" }));
      if (progress >= 1) setRunning(false);
    });
    cancelPlayback.current = cancel;
    return () => { cancel(); if (cancelPlayback.current === cancel) cancelPlayback.current = null; };
  }, [running, duration, playbackId]);
  const select = (scenario: Scenario) => {
    stop(); setVisible(true);
    const interrupted = scenario === "failed" || scenario === "cancelled";
    if (!interrupted) unknown.current = scenario === "unknown";
    const next = interrupted ? { ...state } : example();
    if (scenario === "checking") Object.assign(next, { phase: "checking", downloadedBytes: 0, totalBytes: null });
    if (scenario === "unknown") next.totalBytes = null;
    if (scenario === "processing") Object.assign(next, { downloadStage: "verifying", downloadedBytes: total, message: "正在校验并保存 Xray 内核…" });
    if (scenario === "completed") Object.assign(next, { phase: "completed", downloadedBytes: total });
    if (scenario === "failed") Object.assign(next, { phase: "failed", errorCode: "download_failed", errorMessage: "下载连接中断，请重试。" });
    if (scenario === "cancelled") Object.assign(next, { phase: "failed", errorCode: "download_cancelled", errorMessage: "下载已取消。" });
    fraction.current = next.downloadedBytes / total;
    setState(next);
  };
  const play = (from: number) => {
    cancelPlayback.current?.();
    fraction.current = Math.max(0, Math.min(1, from));
    setPlaybackId(value=>value+1);
    setVisible(true);
    setState({ ...example(), downloadedBytes: fraction.current * total, totalBytes: unknown.current ? null : total });
    setRunning(fraction.current < 1);
  };
  const start = () => play(0);
  const componentState = { ...state, currentComponent: target === "geoip" ? "geoip" as const : target === "geosite" ? "geosite" as const : "xray" as const,
    fileName: target === "geoip" ? "geoip.dat" : target === "geosite" ? "geosite.dat" : state.fileName };
  const appState: UpdateDownloadState = {
    phase: state.downloadStage === "verifying" && state.phase === "downloading" ? "verifying" : state.phase === "checking" ? "preparing" : state.phase === "ready" ? "completed" : state.phase,
    fileName: navigator.userAgent.includes("Windows") ? "ChordV_1.1.8_x64-full.zip" : "ChordV_1.1.8.dmg",
    downloadedBytes: state.downloadedBytes, totalBytes: state.totalBytes, localPath: null, message: state.errorMessage || null
  };
  return <>
    {!opened ? <Button className={styles.launcher} variant="default" size="xs" leftSection={<IconAdjustments size={14}/>} onClick={()=>{setOpened(true);setVisible(true);}}>下载调试</Button> : null}
    {opened ? <aside className={styles.window} role="dialog" aria-label="本地下载调试">
      <Group justify="space-between"><Text fw={600} size="sm">本地下载调试</Text><Button variant="subtle" color="gray" size="compact-xs" aria-label="关闭调试窗口" onClick={()=>setOpened(false)}><IconX size={16}/></Button></Group>
      <Text size="xs" c="dimmed" mt={5}>仅模拟展示，不下载文件、不调用接口。</Text>
      <Stack gap="md" mt="md">
        <Select label="下载类型" value={target} onChange={value=>{stop();setTarget(value||"xray");setInstallSimulated(false);setVisible(true);}} data={[{value:"xray",label:"Xray 内核"},{value:"geoip",label:"GeoIP 规则"},{value:"geosite",label:"GeoSite 规则"},{value:"app",label:"客户端更新包"}]}/>
        {installSimulated ? <Text size="xs" c="teal">安装动作已触发（仅模拟，不会重启）</Text> : null}
        <Group gap={6}>{([
          ["checking", "检查"], ["downloading", "79% 示例"], ["unknown", "未知大小"], ["processing", "校验"], ["failed", "失败"], ["cancelled", "取消"], ["completed", "完成"]
        ] as const).map(([value,label])=><Button key={value} size="compact-xs" variant="light" onClick={()=>select(value)}>{label}</Button>)}</Group>
        <Select label="完整下载时长" description="继续时按剩余比例计时" value={duration} onChange={value=>setDuration(value||"15")} data={[{value:"5",label:"5 秒"},{value:"15",label:"15 秒"},{value:"60",label:"60 秒"}]}/>
        <div><Text size="xs" mb={8}>手动进度</Text><Slider aria-label="模拟下载进度" value={Math.round(fraction.current*100)} onChange={value=>{stop();fraction.current=value/100;setVisible(true);setState({...example(),phase:value===100?"completed":"downloading",downloadedBytes:total*value/100,totalBytes:unknown.current?null:total});}}/></div>
        <Group gap="xs">
          <Button size="xs" onClick={()=>play(fraction.current)} disabled={running || fraction.current >= 1}>{fraction.current >= 1 ? "已完成" : fraction.current > 0 ? "继续模拟" : "开始模拟"}</Button>
          <Button size="xs" variant="default" onClick={stop} disabled={!running}>暂停模拟</Button>
          <Button size="xs" variant="subtle" onClick={start}>从头重播</Button>
        </Group>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={()=>{setVisible(value=>!value);stop();}}>{visible ? "隐藏模拟面板" : "显示模拟面板"}</Button>
        {realDownloadVisible ? <Text size="xs" c="orange">真实组件任务正在显示，模拟面板暂时隐藏。</Text> : null}
      </Stack>
    </aside> : null}
    {visible && !realDownloadVisible ? <div className="desktop-runtime-overlay"><div className="desktop-runtime-overlay__inner">{target === "app" ? <ClientUpdateProgressPanel state={appState} version="1.1.8" onRetry={start} onInstall={()=>{setInstallSimulated(true);setOpened(true);}}/> : <RuntimeAssetsBanner state={componentState} onCancel={()=>select("cancelled")} onRetry={start}/>}</div></div> : null}
  </>;
}
export default function DownloadProgressPreview() { return <DownloadProgressDebug standalone/>; }
