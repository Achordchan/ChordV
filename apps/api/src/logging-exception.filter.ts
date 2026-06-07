import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";

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
      status: (code: number) => { json: (body: unknown) => void };
    }>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const path = request.originalUrl ?? request.url ?? "unknown";
    const requestId = readHeader(request.headers, "x-request-id") ?? readHeader(request.headers, "cf-ray") ?? "-";

    if (status >= 500) {
      const message = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `${request.method ?? "UNKNOWN"} ${path} failed with HTTP ${status} requestId=${requestId} ip=${request.ip ?? "-"}: ${message}`,
        exception instanceof Error ? exception.stack : undefined
      );
    }

    const payload = exception instanceof HttpException ? exception.getResponse() : null;
    if (typeof payload === "object" && payload !== null) {
      response.status(status).json(payload);
      return;
    }
    response.status(status).json({
      statusCode: status,
      message: status >= 500 ? "Internal server error" : payload ?? "Request failed",
      path
    });
  }
}

function readHeader(headers: Record<string, string | string[] | undefined> | undefined, name: string) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}
