import { request } from "./base";
export type ComponentVersion = { id: string; versionLabel: string | null; requestedVersion: string | null; status: string; bytesReceived: string; fileSizeBytes: string | null; lastError: string | null; createdAt: string; fileHash: string | null; publishedAt: string | null; sourceUrl: string; resolvedUrl: string | null };
export type ComponentDelivery = { id: string; kind: "xray" | "geoip" | "geosite"; platform: "windows" | "macos" | "android" | "ios"; architecture: "x64" | "arm64"; sourceUrl: string; autoLatest: boolean; enabled: boolean; managed: boolean; active: ComponentVersion | null; versions: ComponentVersion[] };
export const fetchComponentDeliveries = () => request<ComponentDelivery[]>("/admin/runtime-versions");
export const acquireComponent = (input: { componentId: string; sourceUrl: string; version?: string; autoLatest: boolean }) => request<{id:string}>("/admin/runtime-versions/acquire", { method: "POST", body: JSON.stringify(input) });
export const setComponentAutoLatest = (id: string, enabled: boolean) => request(`/admin/runtime-versions/${id}/auto-latest`, { method: "PATCH", body: JSON.stringify({enabled}) });
export const activateComponentVersion = (id: string) => request(`/admin/runtime-versions/${id}/activate`, {method:"POST"});
