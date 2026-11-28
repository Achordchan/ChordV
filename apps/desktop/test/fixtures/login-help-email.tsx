import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import "../../src/styles.css";
import { LoginScreen } from "../../src/components/LoginScreen";

// 仅测试页面替换原生传输边界，不调用系统邮件应用或外部服务。
const requests: string[] = [];
const pending: Array<() => void> = [];
const mode = new URLSearchParams(location.search).get("mode");
Object.assign(window, { loginHelpEmailTest: { requests, rejectPending: () => pending.shift()!() }, mygo: {
  platform: "darwin", on: () => () => {},
  call: async (_method: string, command: string, payload: { url: string }) => {
    if (command !== "open_external_url") throw new Error(`Unexpected test-only command: ${command}`);
    requests.push(payload.url);
    if (mode === "reject") throw new Error("test-only native opener rejection");
    if (mode === "delayed") return new Promise((_, reject) => { pending.push(() => reject(new Error("test-only delayed rejection"))); });
    return { ok: mode !== "false" };
  }
} });
function Fixture() {
  const [email, setEmail] = useState("login-help@test.invalid");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  return <MantineProvider><LoginScreen email={email} password={password} rememberPassword={remember}
    loading={false} error={null} emergencyRuntimeActive={false} emergencyRuntimeBusy={false} emergencyRuntimeMessage={null}
    onEmailChange={setEmail} onPasswordChange={setPassword} onRememberPasswordChange={setRemember}
    onSubmit={() => {}} onEmergencyDisconnect={() => {}} /></MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
