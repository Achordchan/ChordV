import type { PlatformTarget } from "@chordv/shared";

export type ReleaseChannel = "stable" | "beta";

export type UpdateDeliveryMode = "desktop_installer_download" | "desktop_full_replace" | "apk_download" | "external_download" | "none";

export type ReleaseArtifactType = "dmg" | "app" | "exe" | "setup.exe" | "zip" | "apk" | "ipa" | "external";

export type ClientUpdateArtifact = {
  downloadCandidates?: string[];
  updaterSignature?: string | null;
  fileType: ReleaseArtifactType;
  downloadUrl: string;
  originDownloadUrl: string | null;
  defaultMirrorPrefix: string | null;
  allowClientMirror: boolean;
  fileName: string | null;
  fileSizeBytes: number | null;
  fileHash: string | null;
  isPrimary: boolean;
  isFullPackage: boolean;
};

export type ClientUpdateCheckResult = {
  platform: PlatformTarget | "ios";
  channel: ReleaseChannel;
  /** Channel of the offered build; older servers omit it. */
  releaseChannel?: ReleaseChannel | null;
  /** Build number of the offered installer; null when unknown or from older servers. */
  latestBuild?: number | null;
  currentVersion: string;
  latestVersion: string;
  minimumVersion: string;
  hasUpdate: boolean;
  forceUpgrade: boolean;
  title: string;
  changelog: string[];
  publishedAt: string | null;
  deliveryMode: UpdateDeliveryMode;
  downloadUrl: string | null;
  artifact: ClientUpdateArtifact | null;
};
