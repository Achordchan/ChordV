export function needsLegacyComponentManagement(rows: Array<{ enabled: boolean; managed?: boolean; active: unknown }>): boolean {
  return rows.some(row => row.enabled && (!row.managed || !row.active || typeof row.active !== "object"
    || !("status" in row.active) || row.active.status !== "ready"));
}
