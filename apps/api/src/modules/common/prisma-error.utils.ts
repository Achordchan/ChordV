import { HttpException, ServiceUnavailableException } from "@nestjs/common";

const PRISMA_TRANSIENT_ERROR_CODES = new Set(["P1001", "P1002", "P1008", "P2024", "P2028", "P2034"]);
const DATABASE_TRANSIENT_MESSAGE_PATTERNS = [
  /connection (?:terminated|closed|lost|reset|refused)/i,
  /database .* unavailable/i,
  /timed out fetching a new connection/i,
  /transaction already closed/i,
  /connection pool/i,
  /pool timeout/i,
  /server closed the connection/i,
  /could not connect to server/i,
  /terminating connection/i
];

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

export function isDatabaseTransientError(error: unknown) {
  if (isPrismaTransientError(error)) {
    return true;
  }
  const message = readErrorMessage(error);
  if (!message) {
    return false;
  }
  return DATABASE_TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

export function toPrismaTransientHttpError(error: unknown, message: string) {
  if (!isDatabaseTransientError(error)) {
    return null;
  }
  return new ServiceUnavailableException(message);
}

export function throwPrismaTransientAsServiceUnavailable(error: unknown, message: string): never {
  throw toPrismaTransientHttpError(error, message) ?? error;
}

export function throwLocalSaveAsServiceUnavailable(error: unknown, message: string): never {
  if (error instanceof HttpException) {
    throw error;
  }
  throw new ServiceUnavailableException(message);
}

export function throwLocalReadAsServiceUnavailable(error: unknown, message: string): never {
  if (error instanceof HttpException) {
    throw error;
  }
  throw new ServiceUnavailableException(message);
}

function readErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "";
}
