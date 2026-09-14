import { Alert, Button, PasswordInput, TextInput } from "@mantine/core";
import { IconArrowRight } from "@tabler/icons-react";
import styles from "./AdminLoginPanel.module.css";

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
    <div className={styles.root}>
      <header className={styles.header}>
        <span className={styles.wordmark}>ChordV<span className={styles.brandDot}>.</span></span>
        <span className={styles.workspaceLabel}>运营后台</span>
      </header>
      <main className={styles.main}>
        <section className={styles.panel} aria-labelledby="admin-login-title">
          <div className={styles.intro}>
            <span className={styles.eyebrow}>管理员登录</span>
            <h1 id="admin-login-title">欢迎回来。</h1>
            <p>登录，继续你的工作。</p>
          </div>
          <form
            className={styles.form}
            aria-busy={props.loading}
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.loading) props.onSubmit();
            }}
          >
            <fieldset className={styles.fields} disabled={props.loading}>
              <TextInput
                label="账号"
                name="username"
                value={props.account}
                placeholder="输入管理员账号"
                onChange={(event) => props.onAccountChange(event.currentTarget.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                required
                aria-describedby={props.error ? "admin-login-error" : undefined}
                classNames={{ input: styles.input, label: styles.label }}
              />
              <PasswordInput
                label="密码"
                name="password"
                value={props.password}
                placeholder="输入密码"
                onChange={(event) => props.onPasswordChange(event.currentTarget.value)}
                autoComplete="current-password"
                required
                aria-describedby={props.error ? "admin-login-error" : undefined}
                classNames={{ input: styles.input, innerInput: styles.passwordInput, label: styles.label }}
              />
            </fieldset>
            {props.error ? <Alert id="admin-login-error" role="alert" color="red" className={styles.error}>{props.error}</Alert> : null}
            <Button
              type="submit"
              fullWidth
              className={styles.submit}
              loading={props.loading}
              rightSection={props.loading ? undefined : <IconArrowRight size={19} stroke={1.7} />}
            >
              {props.loading ? "正在登录" : "登录后台"}
            </Button>
            <span className={styles.liveStatus} role="status">{props.loading ? "正在验证账号，请稍候。" : ""}</span>
          </form>
        </section>
      </main>
      <footer className={styles.footer}><span>ChordV</span><span>运营管理，从这里开始</span></footer>
    </div>
  );
}
