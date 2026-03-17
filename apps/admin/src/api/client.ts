import type {
  AdminPanelConfigDto,
  AdminSnapshotDto,
  AdminSubscriptionRecordDto,
  PanelSyncRunDto,
  UpdatePanelInputDto,
  UpdateSubscriptionInputDto
} from "@chordv/shared";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000";

export async function getAdminSnapshot(): Promise<AdminSnapshotDto> {
  const response = await fetch(`${API_BASE}/api/admin/snapshot`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<AdminSnapshotDto>;
}

export async function updateSubscription(
  subscriptionId: string,
  input: UpdateSubscriptionInputDto
): Promise<AdminSubscriptionRecordDto> {
  const response = await fetch(`${API_BASE}/api/admin/subscriptions/${subscriptionId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<AdminSubscriptionRecordDto>;
}

export async function updatePanel(panelId: string, input: UpdatePanelInputDto): Promise<AdminPanelConfigDto> {
  const response = await fetch(`${API_BASE}/api/admin/panels/${panelId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<AdminPanelConfigDto>;
}

export async function syncPanels(): Promise<PanelSyncRunDto[]> {
  const response = await fetch(`${API_BASE}/api/admin/panels/sync`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<PanelSyncRunDto[]>;
}

export async function syncPanel(panelId: string): Promise<PanelSyncRunDto> {
  const response = await fetch(`${API_BASE}/api/admin/panels/${panelId}/sync`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json() as Promise<PanelSyncRunDto>;
}
