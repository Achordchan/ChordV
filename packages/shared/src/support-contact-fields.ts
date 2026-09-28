/**
 * 打开工单时附带给 Achord Connect 的联系人资料字段（user.attributes），客服在联系人卡片上看到。
 * 这些字段必须先在 Achord Connect 的连接配置（外部接入 → 联系人资料字段）里逐个声明，键名只能是小写字母、数字和下划线；
 * 未声明时工单系统会拒绝整个请求，后台会自动改为不附带资料再试一次。最多 10 个字段，全部为文本类型。
 */
export const SUPPORT_CONTACT_PROFILE_FIELDS = [
  { key: "app_version", label: "客户端版本", type: "text" },
  { key: "os", label: "系统", type: "text" },
  { key: "timezone", label: "时区", type: "text" },
  { key: "locale", label: "系统语言", type: "text" },
  { key: "update_channel", label: "更新通道", type: "text" },
  { key: "connection", label: "连接", type: "text" },
  { key: "line_status", label: "线路状态", type: "text" },
  { key: "recent_errors", label: "最近错误", type: "text" },
  { key: "components", label: "连接组件", type: "text" },
  { key: "plan", label: "套餐", type: "text" }
] as const;

export type SupportContactProfileFieldKey = (typeof SUPPORT_CONTACT_PROFILE_FIELDS)[number]["key"];

/** 单个资料值的长度上限：工单系统限制 500（按 UTF-16 码元计算）。 */
export const SUPPORT_CONTACT_ATTRIBUTE_MAX_LENGTH = 500;
