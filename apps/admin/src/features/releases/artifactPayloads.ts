import updateLimits from "@chordv/shared/update-limits";
import type {
  AdminReleaseArtifactType,
  AdminReleasePlatform,
  CreateAdminReleaseArtifactInputDto
} from "../../api/client";
import type { ArtifactEditorFormState, ReleaseEditorFormState } from "./types";

const { MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES } = updateLimits;

type WindowsExternalDeliveryMode = ReleaseEditorFormState["externalDeliveryMode"] | ArtifactEditorFormState["externalDeliveryMode"];

export const DESKTOP_UPDATE_DOWNLOAD_LIMIT_LABEL = `1 GiB（${MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES} 字节）`;

export function validateExternalArtifactMetadata(fileSizeBytes: string, _fileHash: string) {
  const normalizedSize = fileSizeBytes.trim();
  if (!/^[1-9]\d*$/.test(normalizedSize)) {
    return "文件大小必须是正整数字节数。";
  }
  const maxSizeText = String(MAX_DESKTOP_UPDATE_DOWNLOAD_BYTES);
  if (
    normalizedSize.length > maxSizeText.length ||
    (normalizedSize.length === maxSizeText.length && normalizedSize > maxSizeText)
  ) {
    return `文件大小不能超过 ${DESKTOP_UPDATE_DOWNLOAD_LIMIT_LABEL}。`;
  }
  return null;
}

export function buildExternalArtifactPayload(
  platform: AdminReleasePlatform,
  downloadUrl: string,
  isPrimary: boolean,
  fileSizeBytes: string,
  fileHash: string,
  externalDeliveryMode: WindowsExternalDeliveryMode = "external_download"
): CreateAdminReleaseArtifactInputDto {
  if ((platform === "windows" || platform === "macos") && !/^https:\/\//i.test(downloadUrl.trim())) {
    throw new Error("桌面外链安装包必须使用 HTTPS 下载地址。");
  }
  const metadataError = validateExternalArtifactMetadata(fileSizeBytes, fileHash);
  if (metadataError) {
    throw new Error(metadataError);
  }
  const type =
    platform === "windows" && externalDeliveryMode === "windows_full_replace_zip"
      ? "zip"
      : platform === "windows"
        ? "external"
        : inferExternalArtifactType(platform, downloadUrl);
  return {
    source: "external",
    type,
    deliveryMode:
      platform === "windows" && externalDeliveryMode === "external_download"
        ? "external_download"
        : deliveryModeForExternalArtifact(platform, type),
    downloadUrl: downloadUrl.trim(),
    fileName: inferFileNameFromUrl(downloadUrl),
    fileSizeBytes: fileSizeBytes.trim(),
    fileHash: /^[a-fA-F0-9]{64}$/.test(fileHash.trim()) ? fileHash.trim().toLowerCase() : null,
    isPrimary
  };
}

function inferExternalArtifactType(platform: AdminReleasePlatform, downloadUrl: string): AdminReleaseArtifactType {
  const pathname = inferUrlPathname(downloadUrl);
  if (platform === "windows") {
    return "external";
  }
  if (platform === "macos") {
    return pathname.endsWith(".dmg") ? "dmg" : "external";
  }
  if (platform === "android") {
    return pathname.endsWith(".apk") ? "apk" : "external";
  }
  return pathname.endsWith(".ipa") ? "ipa" : "external";
}

function deliveryModeForExternalArtifact(platform: AdminReleasePlatform, type: AdminReleaseArtifactType) {
  if (platform === "windows" && type === "zip") {
    return "desktop_full_replace" as const;
  }
  if (platform === "macos" && type === "dmg") {
    return "desktop_installer_download" as const;
  }
  if (platform === "android" && type === "apk") {
    return "apk_download" as const;
  }
  return "external_download" as const;
}

function inferUrlPathname(downloadUrl: string) {
  try {
    return new URL(downloadUrl.trim()).pathname.toLowerCase();
  } catch {
    return downloadUrl.trim().toLowerCase();
  }
}

function inferFileNameFromUrl(downloadUrl: string) {
  try {
    const pathname = new URL(downloadUrl.trim()).pathname;
    const fileName = pathname.split("/").filter(Boolean).pop();
    return fileName ? decodeURIComponent(fileName) : null;
  } catch {
    return null;
  }
}
