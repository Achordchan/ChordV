import { Button, CopyButton, Group, Stack, Table, Text } from "@mantine/core";
import { SUPPORT_CONTACT_PROFILE_FIELDS, type AdminSupportContactAttributesStatusDto } from "@chordv/shared";

const TYPE_LABELS: Record<string, string> = { text: "文本", number: "数字", boolean: "是/否", date: "日期" };

/** 复制给管理员、逐项填进 Achord Connect 连接配置的字段列表：每行“键名 标签 类型”，用制表符分隔。 */
export const SUPPORT_CONTACT_FIELDS_COPY_TEXT = [
  "键名\t显示名称\t类型",
  ...SUPPORT_CONTACT_PROFILE_FIELDS.map((field) => `${field.key}\t${field.label}\t${TYPE_LABELS[field.type] ?? field.type}`)
].join("\n");

function formatTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { hour12: false }) : "";
}

function StatusLine({ status }: { status: AdminSupportContactAttributesStatusDto | undefined }) {
  if (!status) return null;
  const at = formatTime(status.checkedAt);
  if (status.status === "rejected") {
    return <Text size="xs" c="orange.8">
      工单系统尚未声明这些字段，暂时不附带{status.code ? `（${status.code}）` : ""}{at ? `，${at} 检查` : ""}。声明后约 10 分钟内自动恢复附带，也可以点“测试连接”立即确认。
    </Text>;
  }
  if (status.status === "accepted") {
    return <Text size="xs" c="teal.8">工单系统已接受这些字段，打开工单时会附带诊断信息{at ? `（最近一次：${at}）` : ""}。</Text>;
  }
  return <Text size="xs" c="dimmed">后台本次启动后还没有附带过这些字段；可以点“测试连接”检查工单系统是否已声明。</Text>;
}

/**
 * “联系人资料字段”：客户端打开工单时，ChordV 把这些诊断信息作为联系人资料（user.attributes）发给工单系统，
 * 客服在联系人卡片上看到。字段必须先在 Achord Connect 的连接配置里声明，否则工单系统会拒绝，后台会自动改为不附带。
 */
export function SupportContactFields({ status }: { status: AdminSupportContactAttributesStatusDto | undefined }) {
  return <Stack gap={6}>
    <Group justify="space-between" gap="xs">
      <Text size="sm" fw={500}>联系人资料字段</Text>
      <CopyButton value={SUPPORT_CONTACT_FIELDS_COPY_TEXT} timeout={2000}>{({ copied, copy }) => <Button size="compact-xs" variant="light" color="teal.9" onClick={copy}>{copied ? "已复制" : "复制字段列表"}</Button>}</CopyButton>
    </Group>
    <Text size="xs" c="dimmed">
      用户打开工单时，ChordV 会把客户端版本、系统、连接状态、套餐等诊断信息作为联系人资料发给工单系统，客服在联系人卡片上可以看到（不含令牌、节点地址、订阅地址或原始错误内容）。
      需要先在 Achord Connect 的连接配置（外部接入 → 联系人资料字段）里按下表逐个声明，类型都选“文本”。
      注意：在那里修改字段会撤销当前所有工单会话，并需要重新检查、激活连接。未声明时打开工单不附带这些信息，不影响使用。
    </Text>
    <Table withTableBorder striped verticalSpacing={4} horizontalSpacing="xs" fz="xs">
      <Table.Thead>
        <Table.Tr><Table.Th>键名</Table.Th><Table.Th>显示名称</Table.Th><Table.Th>类型</Table.Th></Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {SUPPORT_CONTACT_PROFILE_FIELDS.map((field) => <Table.Tr key={field.key}>
          <Table.Td ff="monospace">{field.key}</Table.Td>
          <Table.Td>{field.label}</Table.Td>
          <Table.Td>{TYPE_LABELS[field.type] ?? field.type}</Table.Td>
        </Table.Tr>)}
      </Table.Tbody>
    </Table>
    <StatusLine status={status}/>
  </Stack>;
}
