export type ProtectedAccessReason = "account_disabled" | "team_access_revoked";

export function resolveProtectedAccessReason(rawMessage: string): ProtectedAccessReason | null {
  if (!rawMessage) {
    return null;
  }
  if (rawMessage.includes("当前账号已禁用")) {
    return "account_disabled";
  }
  if (rawMessage.includes("当前成员已失去团队访问权限")) {
    return "team_access_revoked";
  }
  return null;
}

export function buildProtectedAccessNotice(reason: ProtectedAccessReason) {
  if (reason === "account_disabled") {
    return {
      title: "账号已禁用",
      message: "当前账号已被管理员禁用，请联系管理员处理。"
    };
  }
  return {
    title: "你已被移出团队",
    message: "当前账号已失去团队订阅，请重新登录或联系管理员处理。"
  };
}
