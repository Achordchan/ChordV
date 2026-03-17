import type { AdminSnapshotDto } from "@chordv/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export async function getAdminSnapshot(): Promise<AdminSnapshotDto> {
  const response = await fetch(`${API_BASE}/api/admin/snapshot`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<AdminSnapshotDto>;
}
