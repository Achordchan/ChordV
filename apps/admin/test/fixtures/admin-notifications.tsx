import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, createTheme, Drawer, MantineProvider, Modal, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "../../src/styles.css";
import { AdminNotifications } from "../../src/features/feedback/AdminNotifications";
import { PoliciesPage } from "../../src/pages/PoliciesPage";
import { AccountSecurityModal } from "../../src/features/system-settings/AccountSecurityModal";
import type { PolicyFormState } from "../../src/utils/admin-forms";
import dialog from "../../src/features/editors/EditorDialog.module.css";

// 仅浏览器组件回归入口；保存计数不是业务接口或生产数据。
function Fixture() {
  const [opened, setOpened] = useState(true);
  const [saved, setSaved] = useState(0);
  const [noticeOpens, setNoticeOpens] = useState(0);
  const [nested, setNested] = useState(false);
  const [security, setSecurity] = useState({ email: "admin-notice@test.invalid", currentPassword: "fixture-current", newPassword: "fixture-next", confirmPassword: "fixture-next" });
  const [form, setForm] = useState<PolicyFormState | null>({ defaultMode: "rule", modes: ["rule", "global", "direct"], blockAds: true, chinaDirect: true, aiServicesProxy: true });
  const scenario = new URLSearchParams(location.search).get("scenario") ?? "policy";
  const save = () => {
    const count = saved + 1;
    setSaved(count);
    for (let index = 0; index < (scenario === "queue" ? 5 : 1); index++) {
      notifications.show({ id: `policy-notice-${count + index}`, title: scenario === "long" ? "存储操作失败" : "操作成功",
        message: scenario === "long" ? "存储请求失败，请核对文件权限。".repeat(100) + "请求编号：fixture-end" : `策略已更新（${count + index}）`,
        color: scenario === "long" ? "red" : "green", autoClose: scenario === "autoclose" ? 1000 : false,
        onOpen: () => setNoticeOpens(count => count + 1) });
    }
  };
  return <MantineProvider theme={createTheme({ fontFamily: "IBM Plex Sans, PingFang SC, Helvetica Neue, sans-serif" })}>
    <AdminNotifications />
    <Text role="status">保存次数：{saved}</Text>
    <Text data-testid="notice-opens">{noticeOpens}</Text>
    <Button onClick={() => setOpened(true)}>打开策略</Button>
    {scenario === "security" ? <AccountSecurityModal opened={opened} onClose={() => setOpened(false)} saving={false}
      form={security} onChange={setSecurity} onSave={save} /> : scenario === "drawer" ? <Drawer opened={opened} onClose={() => setOpened(false)} title="连接策略" position="right" size={620}>
        {form && <PoliciesPage policyForm={form} setPolicyForm={setForm} policySaving={false} onSave={save} />}
      </Drawer> : <Modal opened={opened} onClose={() => setOpened(false)} title="连接策略" centered size={620} closeOnClickOutside={false}
      classNames={{ content: dialog.content, header: dialog.header, title: dialog.title, body: dialog.body }}>
      {scenario === "nested" && <Button onClick={() => setNested(true)}>打开确认弹窗</Button>}
      {form && <PoliciesPage policyForm={form} setPolicyForm={setForm} policySaving={false} onSave={save} />}
    </Modal>}
    <Modal opened={nested} onClose={() => setNested(false)} title="确认操作" centered>
      <Text>仅测试嵌套弹窗的通知归属。</Text>
      <Button onClick={save}>确认并提示</Button>
    </Modal>
  </MantineProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
