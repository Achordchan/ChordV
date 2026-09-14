import { useState } from "react";
import { Button, Checkbox, Group, Modal, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { IconLock, IconMail, IconSend } from "@tabler/icons-react";
import { openExternalUrl } from "../lib/runtime";
import appIcon from "../../src-tauri/icons/icon.png";
import "./LoginScreen.css";

type LoginScreenProps = {
  email: string;
  password: string;
  rememberPassword: boolean;
  loading: boolean;
  error: string | null;
  windowLayoutError?: string | null;
  windowResizeBusy?: boolean;
  onRetryWindowLayout?: () => void;
  emergencyRuntimeActive: boolean;
  emergencyRuntimeBusy: boolean;
  emergencyRuntimeMessage: string | null;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onRememberPasswordChange: (checked: boolean) => void;
  onSubmit: () => void;
  onEmergencyDisconnect: () => void;
};

const SUPPORT_EMAIL = "achordchan@gmail.com";

export function LoginScreen(props: LoginScreenProps) {
  const [helpOpened, setHelpOpened] = useState(false);

  const openSupportEmail = () => {
    const subject = encodeURIComponent("ChordV 账号密码协助");
    const body = encodeURIComponent(
      [
        "你好，我需要协助处理 ChordV 账号密码问题。",
        "",
        `登录邮箱：${props.email.trim() || "请填写你的登录邮箱"}`,
        "问题类型：忘记密码 / 修改密码 / 登录失败",
        "补充说明："
      ].join("\n")
    );
    void openExternalUrl(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`);
  };

  return (
    <div className="auth-screen">
      <div className="auth-screen__shell">
        <section className="auth-screen__brand" aria-label="ChordV">
          <img src={appIcon} alt="" className="auth-screen__logo" />
          <h1 className="auth-screen__brand-title">ChordV</h1>
        </section>

        <div className="auth-screen__panel">
          <form className="auth-screen__panel-inner" onSubmit={(event) => {
            event.preventDefault();
            if (!props.loading) props.onSubmit();
          }}>
            <h2 className="auth-screen__panel-title">账号登录</h2>
            {props.windowLayoutError && (
              <div className="auth-screen__error" role="alert">
                <Text size="sm">{props.windowLayoutError}</Text>
                <Button type="button" size="xs" variant="light" mt={8} loading={props.windowResizeBusy} onClick={props.onRetryWindowLayout}>重试窗口调整</Button>
              </div>
            )}
            <div className="auth-screen__form">
              <label className="auth-screen__field">
                <span className="auth-screen__field-label">邮箱</span>
                <TextInput
                  type="email"
                  required
                  aria-label="邮箱"
                  placeholder="请输入邮箱"
                  value={props.email}
                  onChange={(event) => props.onEmailChange(event.currentTarget.value)}
                  disabled={props.loading}
                  autoComplete="username"
                  leftSection={<IconMail size={18} stroke={1.8} />}
                  classNames={{
                    input: "auth-screen__control",
                    section: "auth-screen__control-section"
                  }}
                />
              </label>

              <label className="auth-screen__field">
                <span className="auth-screen__field-label">密码</span>
                <PasswordInput
                  required
                  aria-label="密码"
                  placeholder="请输入密码"
                  value={props.password}
                  onChange={(event) => props.onPasswordChange(event.currentTarget.value)}
                  disabled={props.loading}
                  autoComplete="current-password"
                  leftSection={<IconLock size={18} stroke={1.8} />}
                  classNames={{
                    input: "auth-screen__control",
                    section: "auth-screen__control-section",
                    visibilityToggle: "auth-screen__visibility-toggle"
                  }}
                />
              </label>
            </div>

            <div className="auth-screen__helper">
              <Checkbox
                label="记住邮箱"
                disabled={props.loading}
                checked={props.rememberPassword}
                onChange={(event) => props.onRememberPasswordChange(event.currentTarget.checked)}
                classNames={{
                  root: "auth-screen__remember",
                  input: "auth-screen__remember-input",
                  label: "auth-screen__remember-label"
                }}
              />
              <button type="button" className="auth-screen__helper-action" onClick={() => setHelpOpened(true)}>
                账号帮助
              </button>
            </div>

            {props.error ? <div className="auth-screen__error" role="alert">{props.error}</div> : null}

            {props.emergencyRuntimeActive ? (
              <div className="auth-screen__runtime-alert">
                <div className="auth-screen__runtime-copy">
                  <strong className="auth-screen__runtime-title">检测到本地连接仍在运行</strong>
                  <span className="auth-screen__runtime-desc">
                    {props.emergencyRuntimeMessage ?? "登录态已失效时，仍可先手动停止本地内核，避免继续占用代理。"}
                  </span>
                </div>
                <Button
                  variant="light"
                  color="red"
                  radius="xl"
                  loading={props.emergencyRuntimeBusy}
                  className="auth-screen__runtime-action"
                  onClick={props.onEmergencyDisconnect}
                >
                  紧急断开内核
                </Button>
              </div>
            ) : null}

            <Button
              size="lg"
              type="submit"
              loading={props.loading}
              fullWidth
              className="auth-screen__submit"
            >
              登录
            </Button>

          </form>
        </div>
      </div>

      <Modal
        opened={helpOpened}
        onClose={() => setHelpOpened(false)}
        title="账号帮助"
        closeButtonProps={{ "aria-label": "关闭账号帮助" }}
        centered
        size="min(92vw, 520px)"
        classNames={{
          content: "auth-help__modal-content",
          header: "auth-help__modal-header",
          body: "auth-help__modal-body"
        }}
      >
        <div className="auth-help">
          <div className="auth-help__scroll">
            <Stack gap={7}>
              <Text size="sm" fw={600}>忘记密码或无法登录</Text>
              <Text size="sm" c="dimmed">
                请发送登录邮箱和购买或团队信息，由管理员核对后协助重置密码。
              </Text>
              <Text size="sm" c="dimmed">
                已登录用户也可通过工单申请修改密码。
              </Text>
            </Stack>
            <div className="auth-help__contact">
              <Text size="xs" c="dimmed">联系邮箱</Text>
              <Text size="sm" className="auth-help__email">{SUPPORT_EMAIL}</Text>
            </div>
          </div>
          <Group justify="flex-end" gap="xs" className="auth-help__actions">
            <Button variant="default" onClick={() => setHelpOpened(false)}>关闭</Button>
            <Button leftSection={<IconSend size={15} />} onClick={openSupportEmail}>发送邮件</Button>
          </Group>
        </div>
      </Modal>
    </div>
  );
}
