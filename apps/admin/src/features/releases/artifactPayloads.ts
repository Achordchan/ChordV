import type {
  AdminReleaseArtifactType,
  AdminReleasePlatform,
  CreateAdminReleaseArtifactInputDto
} from "../../api/client";
import type { ArtifactEditorFormState, ReleaseEditorFormState } from "./types";

type WindowsExternalDeliveryMode = ReleaseEditorFormState["externalDeliveryMode"] | ArtifactEditorFormState["externalDeliveryMode"];

export function buildExternalArtifactPayload(
  platform: AdminReleasePlatform,
  downloadUrl: string,
  isPrimary: boolean,
  externalDeliveryMode: WindowsExternalDeliveryMode = "external_download"
): CreateAdminReleaseArtifactInputDto {
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
