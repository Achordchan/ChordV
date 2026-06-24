import type { AdminRuntimeComponentRecordDto, AdminRuntimeComponentValidationDto } from "../../api/client";

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
  if (isRuntimeComponentDeliveryError(record.clientDeliveryStatus)) {
    return {
      label: getRuntimeComponentDeliveryErrorLabel(record.clientDeliveryStatus),
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

export function applyRuntimeComponentValidationToDelivery(
  record: AdminRuntimeComponentRecordDto,
  validation: AdminRuntimeComponentValidationDto
): AdminRuntimeComponentRecordDto {
  if (validation.status === "ready") {
    return {
      ...record,
      fileSizeBytes: validation.actualFileSizeBytes ?? record.fileSizeBytes,
      fileHash: validation.actualFileHash ?? record.fileHash,
      expectedHash: validation.actualFileHash ?? record.expectedHash,
      clientDeliverable: true,
      clientDeliveryStatus: "ready",
      clientDeliveryMessage: validation.message || "组件已校验通过，可下发给客户端。"
    };
  }
  if (validation.status === "disabled") {
    return {
      ...record,
      clientDeliverable: false,
      clientDeliveryStatus: "disabled",
      clientDeliveryMessage: validation.message || "组件已停用，客户端不会获取。"
    };
  }
  const status = isRuntimeComponentDeliveryError(validation.status) ? validation.status : "pending_validation";
  return {
    ...record,
    clientDeliverable: false,
    clientDeliveryStatus: status,
    clientDeliveryMessage: validation.message || "组件校验未通过，不会下发给客户端。"
  };
}

function isRuntimeComponentDeliveryError(
  status: AdminRuntimeComponentRecordDto["clientDeliveryStatus"] | AdminRuntimeComponentValidationDto["status"]
) {
  return (
    status === "metadata_mismatch" ||
    status === "missing_file" ||
    status === "invalid_url" ||
    status === "unreachable" ||
    status === "save_failed"
  );
}

function getRuntimeComponentDeliveryErrorLabel(status: NonNullable<AdminRuntimeComponentRecordDto["clientDeliveryStatus"]>) {
  if (status === "metadata_mismatch") {
    return "Hash 不一致";
  }
  if (status === "missing_file") {
    return "文件缺失";
  }
  if (status === "invalid_url") {
    return "链接有误";
  }
  if (status === "save_failed") {
    return "保存失败";
  }
  return "无法访问";
}
