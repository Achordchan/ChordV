import { Button, Paper, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";

type LoginScreenProps = {
  email: string;
  password: string;
  loading: boolean;
  error: string | null;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
};

export function LoginScreen(props: LoginScreenProps) {
  return (
    <div className="desktop-login">
      <Paper className="desktop-login-card" radius="xl" withBorder p="xl">
        <Stack gap="lg">
          <div>
            <Text className="desktop-eyebrow">ChordV</Text>
            <Title order={2} mt="xs">
              登录客户端
            </Title>
            <Text c="dimmed" mt="xs">
              使用你的账号进入桌面端
            </Text>
          </div>

          <TextInput
            label="邮箱"
            placeholder="name@example.com"
            value={props.email}
            onChange={(event) => props.onEmailChange(event.currentTarget.value)}
            autoComplete="username"
          />

          <PasswordInput
            label="密码"
            placeholder="请输入密码"
            value={props.password}
            onChange={(event) => props.onPasswordChange(event.currentTarget.value)}
            autoComplete="current-password"
          />

          {props.error ? (
            <Text c="red.6" size="sm">
              {props.error}
            </Text>
          ) : null}

          <Button size="lg" onClick={props.onSubmit} loading={props.loading}>
            登录
          </Button>
        </Stack>
      </Paper>
    </div>
  );
}
