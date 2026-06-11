import { ServiceUnavailableException } from "@nestjs/common";

const PRISMA_TRANSIENT_ERROR_CODES = new Set(["P1001", "P1002", "P1008", "P2024", "P2028", "P2034"]);

export function isPrismaCodedError(error: unknown): error is { code: string } {
  const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
  return (
    typeof code === "string" &&
    /^P\d{4}$/.test(code)
  );
}

export function isPrismaTransientError(error: unknown) {
  if (!isPrismaCodedError(error)) {
    return false;
  }
  return PRISMA_TRANSIENT_ERROR_CODES.has(String(error.code));
}

export function toPrismaTransientHttpError(error: unknown, message: string) {
  if (!isPrismaTransientError(error)) {
    return null;
  }
  return new ServiceUnavailableException(message);
}

export function throwPrismaTransientAsServiceUnavailable(error: unknown, message: string): never {
  throw toPrismaTransientHttpError(error, message) ?? error;
}
