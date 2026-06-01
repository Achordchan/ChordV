const DEFAULT_CORS_ORIGINS = ["https://v.baymaxgroup.com"];
const DESKTOP_APP_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost"
]);

export function resolveCorsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
  if (!origin || isAllowedCorsOrigin(origin)) {
    callback(null, true);
    return;
  }
  callback(null, false);
}

export function isAllowedCorsOrigin(origin: string) {
  const normalized = origin.trim().replace(/\/+$/, "");
  if (!normalized) {
    return true;
  }
  if (allowedCorsOrigins().has(normalized)) {
    return true;
  }
  if (DESKTOP_APP_ORIGINS.has(normalized)) {
    return true;
  }
  if (allowLocalDevOrigins() && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(normalized)) {
    return true;
  }
  return allowLocalDevOrigins() && (normalized === "http://tauri.localhost" || normalized === "https://tauri.localhost");
}

function allowLocalDevOrigins() {
  const configured = (process.env.CHORDV_ALLOW_LOCAL_DEV_ORIGINS ?? "").trim().toLowerCase();
  if (configured) {
    return configured === "1" || configured === "true" || configured === "yes";
  }
  return process.env.NODE_ENV !== "production";
}

function allowedCorsOrigins() {
  const values = [
    ...DEFAULT_CORS_ORIGINS,
    process.env.CHORDV_CORS_ORIGINS,
    process.env.CHORDV_API_BASE_URL,
    process.env.CHORDV_PUBLIC_BASE_URL,
    process.env.CHORDV_ADMIN_BASE_URL
  ];
  return new Set(
    values
      .flatMap((value) => (value ?? "").split(","))
      .map((value) => normalizeOrigin(value))
      .filter((value): value is string => Boolean(value))
  );
}

function normalizeOrigin(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).origin.replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}
