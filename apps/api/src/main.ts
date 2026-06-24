import "dotenv/config";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { resolveCorsOrigin } from "./cors";
import { LoggingExceptionFilter } from "./logging-exception.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: resolveCorsOrigin,
      credentials: true,
      exposedHeaders: ["X-Request-Id"]
    }
  });

  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  const forceHttps = (process.env.CHORDV_API_FORCE_HTTPS ?? "true").toLowerCase() === "true";
  if (process.env.NODE_ENV === "production" && forceHttps) {
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
    app.use(
      (
        req: { secure?: boolean; headers: Record<string, string | string[] | undefined> },
        res: { status: (code: number) => { json: (body: unknown) => void } },
        next: () => void
      ) => {
      const forwardedProto = Array.isArray(req.headers["x-forwarded-proto"])
        ? req.headers["x-forwarded-proto"][0]
        : req.headers["x-forwarded-proto"];
      if (req.secure || forwardedProto === "https") {
        next();
        return;
      }
      res.status(426).json({
        message: "生产环境仅允许 HTTPS 访问"
      });
      }
    );
  }
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true
    })
  );
  app.useGlobalFilters(new LoggingExceptionFilter());

  const port = Number(process.env.CHORDV_API_PORT ?? 3000);
  await app.listen(port);
  configureHttpServerTimeouts(app.getHttpServer());
  console.log(`ChordV API listening on http://localhost:${port}/api`);
}

function configureHttpServerTimeouts(server: {
  requestTimeout?: number;
  headersTimeout?: number;
  keepAliveTimeout?: number;
}) {
  const requestTimeoutMs = readPositiveIntegerEnv("CHORDV_API_REQUEST_TIMEOUT_MS", 11 * 60 * 1000);
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, Math.max(server.headersTimeout ?? 0, 60 * 1000));
}

function readPositiveIntegerEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

bootstrap();
