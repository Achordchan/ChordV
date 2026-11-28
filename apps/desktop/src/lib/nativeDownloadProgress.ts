

export function readRuntimeProgressString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null;
}

export function readRuntimeProgressNumber(primary: unknown, fallback: unknown) {
  const candidate = readFiniteProgressNumber(primary) ?? readFiniteProgressNumber(fallback) ?? 0;
  if (candidate < 0) {
    return 0;
  }
  return candidate;
}

export function readRuntimeProgressNullableNumber(primary: unknown, fallback: unknown) {
  const value = readFiniteProgressNumber(primary) ?? readFiniteProgressNumber(fallback);
  if (value === null || value <= 0) {
    return null;
  }
  return value;
}

function readFiniteProgressNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  return null;
}
