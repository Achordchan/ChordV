import type { AdminUserRecordDto } from "@chordv/shared";

/** Editing transfers ownership within the team; creating starts with an unassigned account. */
export function teamOwnerOptions(users: AdminUserRecordDto[], teamId: string | null, currentOwnerId?: string) {
  return users.filter(user => user.role === "user" && user.teamId === teamId &&
    (user.status === "active" || user.id === currentOwnerId)
  ).map(user => ({ value: user.id, label: `${user.displayName} · ${user.email}`, disabled: user.status !== "active" }));
}
