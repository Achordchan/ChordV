const GB_IN_BYTES = 1024n * 1024n * 1024n;

export function trafficGbNumberToBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const text = value.toString().toLowerCase();
  const [mantissa, exponentText = "0"] = text.split("e");
  const exponent = Number(exponentText);
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`.replace(/^\+/, "");
  if (!/^\d+$/.test(digits) || !Number.isInteger(exponent)) return 0n;
  const decimalPlaces = fraction.length - exponent;
  const numerator = BigInt(digits) * GB_IN_BYTES;
  if (decimalPlaces <= 0) return numerator * 10n ** BigInt(-decimalPlaces);
  const denominator = 10n ** BigInt(decimalPlaces);
  return (numerator + denominator / 2n) / denominator;
}

export function trafficBytesToGbNumber(value: bigint) {
  if (value <= 0n) return 0;
  const whole = value / GB_IN_BYTES;
  const remainder = value % GB_IN_BYTES;
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("流量字节数超出兼容展示范围");
  }
  return Number(whole) + Number(remainder) / Number(GB_IN_BYTES);
}
