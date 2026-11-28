import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, Stack } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { mockBootstrap, mockNodes } from "../../../../packages/shared/src/mock";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "../../src/styles.css";
import { SubscriptionPanel } from "../../src/components/SubscriptionPanel";
import { NodeListPanel } from "../../src/components/NodeListPanel";
import { ControlPanel } from "../../src/components/ControlPanel";
import { LoginScreen } from "../../src/components/LoginScreen";
import { showToast, toastContainerClassNames } from "../../src/components/Toast";
import type { NativeLifecycleNotice } from "../../src/lib/nativeLifecycle";
import { NativeLifecycleFeedback } from "../../src/components/NativeLifecycleFeedback";
import { createIdleRuntimeStatus } from "../../src/lib/nativeRuntime";
import { TOAST_AUTO_CLOSE_MS, TOAST_LIMIT, TOAST_WIDTH } from "../../src/lib/toast";

// 仅真实组件布局回归：事件注入和按钮计数只存在于本测试入口；不调用API或原生进程。
function Fixture() {
  const mode = new URLSearchParams(location.search).get("mode") ?? "user";
  const [email, setEmail] = useState("test@layout.invalid");
  const [password, setPassword] = useState("test-only-password");
  const [remember, setRemember] = useState(false);
  const [notice, setNotice] = useState<NativeLifecycleNotice | null>(null);
  const click = (name: string) => () => (window as any).lifecycleLayoutTest.clicks.push(name);
  useEffect(() => {
    Object.assign(window, { lifecycleLayoutTest: {
      clicks: [],
      notice: setNotice,
      ordinary: () => showToast({ title: "保存完成", message: "普通短时提示", tone: "success" })
    } });
  }, []);
  const team = mode === "team";
  const bootstrap = { ...mockBootstrap,
    user: { ...mockBootstrap.user, displayName: "布局验收用户", email: "support-client-00000000-0000-4000-8000-000000000000@chordv.local" },
    team: null,
    subscription: { ...mockBootstrap.subscription, ownerType: team ? "team" as const : "user" as const,
      teamName: team ? "布局验收团队" : null, planName: "组件测试套餐", remainingTrafficGb: 9.98,
      totalTrafficGb: 10, usedTrafficGb: 0.02, memberUsedTrafficGb: 0, expireAt: "2099-01-01T00:00:00Z" }
  };
  return <MantineProvider theme={{ primaryColor: "cyan" }}>
    <Notifications position="top-right" autoClose={TOAST_AUTO_CLOSE_MS} limit={TOAST_LIMIT}
      containerWidth={TOAST_WIDTH} classNames={toastContainerClassNames} />
    <div className={`desktop-app desktop-app--mac-titlebar${mode === "login" ? " desktop-app--login" : ""}`}>
      <div className="app-titlebar"><span className="app-titlebar__title">ChordV 布局回归</span></div>
      {mode === "login" ? <LoginScreen email={email} password={password} rememberPassword={remember}
        loading={false} error="邮箱或密码错误" emergencyRuntimeActive={false} emergencyRuntimeBusy={false}
        emergencyRuntimeMessage={null} onEmailChange={setEmail} onPasswordChange={setPassword}
        onRememberPasswordChange={setRemember} onSubmit={click("login")} onEmergencyDisconnect={click("disconnect")}
        lifecycleFeedback={notice ? { notice, onDismiss: () => setNotice(null) } : undefined} /> :
        <div className={`desktop-main${notice ? " desktop-main--lifecycle-feedback" : ""}`}>
          <Stack gap="sm"><SubscriptionPanel bootstrap={bootstrap} hasUnreadAnnouncements={false} supportUnreadCount={0}
            refreshing={false} updateBusy={false} hasUpdate={false} serverProbe={{ status: "healthy", label: "服务正常", detail: "本地组件测试" }}
            onOpenAnnouncements={click("announcements")} onOpenTickets={click("tickets")} onRefresh={click("refresh")}
            onCheckUpdate={click("update")} onLogout={click("logout")} /></Stack>
          {notice ? <NativeLifecycleFeedback notice={notice} onDismiss={() => setNotice(null)} /> : null}
          <div className="desktop-content">
            <NodeListPanel nodes={mockNodes.slice(0, 2)} selectedNodeId={mockNodes[0].id} probeResults={{}}
              probeBusy={false} probeCooldownLeft={0} onSelect={click("select-node")} onProbe={click("probe")} />
            <ControlPanel modes={["rule", "global", "direct"]} mode="rule" canConnect modeLocked={false}
              primaryBusy={false} primaryLabel="启动连接" desktopStatus={createIdleRuntimeStatus("macos")}
              runtime={null} error={null} runtimeAssetsPhase="ready" onModeChange={click("mode")}
              onPrimaryAction={click("connect")} onOpenRoutingRules={click("routing")} onOpenLogs={click("diagnostics")} />
          </div>
        </div>}
    </div>
  </MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
