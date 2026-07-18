export function normalizeSha256Hex(value?: string | null) {
  const raw = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(raw) ? raw : null;
}
