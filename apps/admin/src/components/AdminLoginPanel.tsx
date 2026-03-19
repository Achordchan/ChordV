import { Alert, Button, Paper, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";

type AdminLoginPanelProps = {
  account: string;
  password: string;
  loading: boolean;
  error: string | null;
  onAccountChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
};

export function AdminLoginPanel(props: AdminLoginPanelProps) {
  return (
    <div className="admin-auth-root">
      <div className="admin-auth-shell">
        <Paper className="admin-auth-intro" radius={32} p={36}>
          <Stack gap={18}>
            <Text className="admin-auth-tag">ChordV 运营后台</Text>
            <Title order={1} className="admin-auth-title">
              安全登录
            </Title>
            <Text className="admin-auth-subtitle">登录后管理用户、套餐、订阅与节点状态，所有操作都将写入审计轨迹。</Text>
            <Paper className="admin-auth-note" radius={20} p="lg">
              <Stack gap={8}>
                <Text className="admin-auth-note-title">本次接入内容</Text>
                <Text className="admin-auth-note-line">- 统一管理员鉴权</Text>
                <Text className="admin-auth-note-line">- 会话过期自动续签</Text>
                <Text className="admin-auth-note-line">- 节点计费异常可追踪</Text>
              </Stack>
            </Paper>
          </Stack>
        </Paper>

        <Paper className="admin-auth-form-card" radius={32} p={36}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              props.onSubmit();
            }}
          >
            <Stack gap="md">
              <Text className="admin-auth-form-tag">管理员登录</Text>
              <Title order={2} className="admin-auth-form-title">
                欢迎回来
              </Title>
              <Text className="admin-auth-form-desc">请输入管理员账号与密码。</Text>

              <TextInput
                label="账号"
                value={props.account}
                placeholder="请输入管理员账号"
                onChange={(event) => props.onAccountChange(event.currentTarget.value)}
                radius="xl"
                size="md"
                autoFocus
              />
              <PasswordInput
                label="密码"
                value={props.password}
                placeholder="请输入密码"
                onChange={(event) => props.onPasswordChange(event.currentTarget.value)}
                radius="xl"
                size="md"
              />

              {props.error ? <Alert color="red">{props.error}</Alert> : null}

              <Button type="submit" radius="xl" size="md" loading={props.loading}>
                登录后台
              </Button>
            </Stack>
          </form>
        </Paper>
      </div>
    </div>
  );
}
