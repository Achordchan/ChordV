import type { AdminNodeRecordDto, AdminSnapshotDto, ImportNodeInputDto } from "@chordv/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

async function request<T>(path: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 12000);
  let response: Response;

  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      signal: init?.signal ?? controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function getAdminSnapshot(): Promise<AdminSnapshotDto> {
  return request<AdminSnapshotDto>("/admin/snapshot");
}

export async function importNode(input: ImportNodeInputDto): Promise<AdminNodeRecordDto> {
  return request<AdminNodeRecordDto>("/admin/nodes/import", {
    method: "POST",
    body: JSON.stringify(input)
  });
}
