import { useState } from "react";
import { Button, Checkbox, Group, Modal, Paper, PasswordInput, Stack, Text, TextInput } from "@mantine/core";
import { IconHelpCircle, IconLock, IconMail, IconSend } from "@tabler/icons-react";
import { openExternalUrl } from "../lib/runtime";
import "./LoginScreen.css";

type LoginScreenProps = {
  email: string;
  password: string;
  rememberPassword: boolean;
  loading: boolean;
  error: string | null;
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
        <section className="auth-screen__brand">
          <div className="auth-screen__hero">
            <p className="auth-screen__brand-eyebrow">Xray内核驱动 稳定连接</p>
            <h1 className="auth-screen__brand-title">ChordV</h1>
            <p className="auth-screen__brand-desc">登录即同步节点与策略，无需重复配置。</p>
          </div>

          <div className="auth-screen__stats">
            <div className="auth-screen__stat-card">
              <span className="auth-screen__stat-label">策略</span>
              <strong className="auth-screen__stat-value">规则分流</strong>
            </div>
            <div className="auth-screen__stat-card">
              <span className="auth-screen__stat-label">状态</span>
              <strong className="auth-screen__stat-value">节点就绪</strong>
            </div>
          </div>

          <div className="auth-screen__note">
            <div className="auth-screen__note-title">登录后自动完成</div>
            <div className="auth-screen__note-list">
              <div className="auth-screen__note-item">订阅状态校验</div>
              <div className="auth-screen__note-item">节点与策略同步</div>
              <div className="auth-screen__note-item">上次连接恢复</div>
            </div>
          </div>
        </section>

        <Paper className="auth-screen__panel" radius={30}>
          <div className="auth-screen__panel-inner">
            <div className="auth-screen__panel-head">
              <p className="auth-screen__panel-eyebrow">账号登录</p>
              <h2 className="auth-screen__panel-title">欢迎回来</h2>
              <p className="auth-screen__panel-desc">登录后恢复订阅、节点与策略状态。</p>
            </div>

            <div className="auth-screen__form">
              <label className="auth-screen__field">
                <span className="auth-screen__field-label">邮箱</span>
                <TextInput
                  placeholder="请输入邮箱"
                  value={props.email}
                  onChange={(event) => props.onEmailChange(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      props.onSubmit();
                    }
                  }}
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
                  placeholder="请输入密码"
                  value={props.password}
                  onChange={(event) => props.onPasswordChange(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      props.onSubmit();
                    }
                  }}
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
                checked={props.rememberPassword}
                onChange={(event) => props.onRememberPasswordChange(event.currentTarget.checked)}
                classNames={{
                  root: "auth-screen__remember",
                  input: "auth-screen__remember-input",
                  label: "auth-screen__remember-label"
                }}
              />
              <button type="button" className="auth-screen__helper-action" onClick={() => setHelpOpened(true)}>
                需要帮助？
              </button>
            </div>

            {props.error ? <div className="auth-screen__error">{props.error}</div> : null}

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
              onClick={props.onSubmit}
              loading={props.loading}
              fullWidth
              className="auth-screen__submit"
            >
              登录 ChordV
            </Button>

            <p className="auth-screen__agreement">继续即表示你同意服务协议与隐私说明。</p>
          </div>
        </Paper>
      </div>

      <Modal
        opened={helpOpened}
        onClose={() => setHelpOpened(false)}
        title="账号帮助"
        centered
        size="min(92vw, 520px)"
        classNames={{
          content: "auth-help__modal-content",
          header: "auth-help__modal-header",
          body: "auth-help__modal-body"
        }}
      >
        <Stack gap="md" className="auth-help">
          <Paper withBorder radius="lg" p="md" className="auth-help__card">
            <Group gap="sm" align="flex-start" wrap="nowrap">
              <IconHelpCircle size={20} className="auth-help__icon" />
              <Stack gap={6}>
                <Text fw={700}>忘记密码</Text>
                <Text size="sm" c="dimmed">
                  当前版本暂不支持客户端自助找回密码。请发送你的登录邮箱和购买/团队信息，由管理员核对后重置。
                </Text>
              </Stack>
            </Group>
          </Paper>

          <Paper withBorder radius="lg" p="md" className="auth-help__card">
            <Group gap="sm" align="flex-start" wrap="nowrap">
              <IconLock size={20} className="auth-help__icon" />
              <Stack gap={6}>
                <Text fw={700}>修改密码</Text>
                <Text size="sm" c="dimmed">
                  已登录用户可通过工单说明需求；无法登录时，直接通过联系邮箱申请重置。
                </Text>
              </Stack>
            </Group>
          </Paper>

          <Paper withBorder radius="lg" p="md" className="auth-help__contact">
            <Stack gap="xs">
              <Text fw={700}>联系邮箱</Text>
              <Text size="sm" className="auth-help__email">
                {SUPPORT_EMAIL}
              </Text>
              <Text size="xs" c="dimmed">
                建议在邮件里写清登录邮箱、问题类型和必要截图，方便管理员快速核对。
              </Text>
            </Stack>
          </Paper>

          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={() => setHelpOpened(false)}>
              关闭
            </Button>
            <Button leftSection={<IconSend size={15} />} onClick={openSupportEmail}>
              发送邮件
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}
