import type { AdminRuntimeComponentRecordDto } from "../../api/client";

export type RuntimeComponentDeliveryState = {
  label: string;
  color: "green" | "yellow" | "red" | "gray";
  description: string;
};

export function getRuntimeComponentDeliveryState(record: AdminRuntimeComponentRecordDto): RuntimeComponentDeliveryState {
  const description = record.clientDeliveryMessage || "客户端下发状态未知，请刷新后重试。";
  if (typeof record.clientDeliverable !== "boolean" || !record.clientDeliveryStatus) {
    return {
      label: "状态未知",
      color: "gray",
      description
    };
  }
  if (record.clientDeliverable) {
    return {
      label: "可下发",
      color: "green",
      description
    };
  }
  if (record.clientDeliveryStatus === "disabled") {
    return {
      label: "已停止下发",
      color: "gray",
      description
    };
  }
  if (record.clientDeliveryStatus === "metadata_mismatch" || record.clientDeliveryStatus === "missing_file" || record.clientDeliveryStatus === "invalid_url") {
    return {
      label:
        record.clientDeliveryStatus === "metadata_mismatch"
          ? "Hash 不一致"
          : record.clientDeliveryStatus === "missing_file"
            ? "文件缺失"
            : "链接有误",
      color: "red",
      description
    };
  }
  return {
    label: record.clientDeliveryStatus === "missing_hash" ? "缺少 SHA" : "待校验",
    color: "yellow",
    description
  };
}
