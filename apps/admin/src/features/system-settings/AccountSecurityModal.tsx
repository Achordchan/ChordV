import { useState } from "react";
import { Button, Modal, PasswordInput, Stack, Switch, Text, TextInput } from "@mantine/core";
import type { Dispatch, SetStateAction } from "react";
import dialog from "../editors/EditorDialog.module.css";
import styles from "./SettingsDialogs.module.css";

type SecurityForm = { email: string; currentPassword: string; newPassword: string; confirmPassword: string };
type Props = {
  opened: boolean;
  saving: boolean;
  form: SecurityForm;
  onChange: Dispatch<SetStateAction<SecurityForm>>;
  onClose: () => void;
  onSave: () => void;
};

export function AccountSecurityModal(props: Props) {
  const [changePassword, setChangePassword] = useState(false);
  const mismatch = Boolean(props.form.confirmPassword) && props.form.newPassword.trim() !== props.form.confirmPassword.trim();
  return <Modal opened={props.opened} onClose={props.onClose} title="账号安全" centered size={520}
    closeOnClickOutside={false} closeOnEscape={!props.saving} withCloseButton={!props.saving}
    classNames={{content:dialog.content,header:dialog.header,title:dialog.title,body:dialog.body}}>
    <form className={`${dialog.form} ${styles.security}`} onSubmit={event=>{event.preventDefault();if(!props.saving)props.onSave();}}>
      <fieldset className={dialog.fields} disabled={props.saving}><Stack gap="xl">
        <TextInput label="管理员账号" required autoComplete="username" value={props.form.email} onChange={event=>{const email=event.currentTarget.value;props.onChange(current=>({...current,email}));}}/>
        <div className={styles.passwordToggle}><div><strong id="change-password-label">修改密码</strong><p>未开启时保留当前密码</p></div><Switch color="teal.9" aria-labelledby="change-password-label" checked={changePassword} disabled={props.saving} onChange={event=>{const checked=event.currentTarget.checked;setChangePassword(checked);if(!checked)props.onChange(current=>({...current,newPassword:"",confirmPassword:""}));}}/></div>
        {changePassword ? <Stack gap="lg">
          <PasswordInput label="新密码" description="至少 8 位" required minLength={8} autoComplete="new-password" value={props.form.newPassword} onChange={event=>{const newPassword=event.currentTarget.value;props.onChange(current=>({...current,newPassword}));}}/>
          <PasswordInput label="确认新密码" required autoComplete="new-password" value={props.form.confirmPassword} error={mismatch?"两次输入的新密码不一致":undefined} onChange={event=>{const confirmPassword=event.currentTarget.value;props.onChange(current=>({...current,confirmPassword}));}}/>
        </Stack> : null}
        <section className={styles.verifyIdentity}><PasswordInput label="当前密码" description="确认身份后保存修改" required autoComplete="current-password" value={props.form.currentPassword} onChange={event=>{const currentPassword=event.currentTarget.value;props.onChange(current=>({...current,currentPassword}));}}/></section>
      </Stack></fieldset>
      <Text className={styles.sessionNote}>保存后将更新当前登录会话，其他会话需要重新登录。</Text>
      <footer className={dialog.footer}><Button type="button" variant="default" onClick={props.onClose} disabled={props.saving}>取消</Button><Button type="submit" color="teal.9" loading={props.saving} disabled={mismatch}>保存修改</Button></footer>
    </form>
  </Modal>;
}
