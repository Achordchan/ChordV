import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { isDatabaseTransientError, isPrismaCodedError } from "./modules/common/prisma-error.utils";

@Catch()
export class LoggingExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(LoggingExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<{
      method?: string;
      originalUrl?: string;
      url?: string;
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
    }>();
    const response = context.getResponse<{
      setHeader?: (name: string, value: string) => void;
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const prismaCodedError = isPrismaCodedError(exception);
    const databaseTransientError = isDatabaseTransientError(exception);
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : prismaCodedError || databaseTransientError
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const path = request.originalUrl ?? request.url ?? "unknown";
    const requestId = readHeader(request.headers, "x-request-id") ?? readHeader(request.headers, "cf-ray") ?? randomUUID();
    response.setHeader?.("X-Request-Id", requestId);

    if (status >= 500) {
      const message = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `${request.method ?? "UNKNOWN"} ${path} failed with HTTP ${status} requestId=${requestId} ip=${request.ip ?? "-"}: ${message}`,
        exception instanceof Error ? exception.stack : undefined
      );
    }

    const payload = exception instanceof HttpException
      ? exception.getResponse()
      : prismaCodedError || databaseTransientError
        ? {
            statusCode: status,
            message: "服务暂时繁忙，请稍后重试。",
            path
          }
        : null;
    if (typeof payload === "object" && payload !== null) {
      response.status(status).json({
        ...payload,
        requestId: readRecordValue(payload, "requestId") ?? requestId
      });
      return;
    }
    response.status(status).json({
      statusCode: status,
      message: status >= 500 ? "Internal server error" : payload ?? "Request failed",
      requestId,
      path
    });
  }
}

function readHeader(headers: Record<string, string | string[] | undefined> | undefined, name: string) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()] ?? readHeaderCaseInsensitive(headers, name);
  return Array.isArray(value) ? value[0] : value;
}

function readHeaderCaseInsensitive(headers: Record<string, string | string[] | undefined> | undefined, name: string) {
  if (!headers) {
    return undefined;
  }
  const lowerName = name.toLowerCase();
  const matchedKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
  return matchedKey ? headers[matchedKey] : undefined;
}

function readRecordValue(record: object, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key) ? (record as Record<string, unknown>)[key] : undefined;
}
