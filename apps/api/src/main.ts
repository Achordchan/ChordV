import "dotenv/config";
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: {
      origin: true,
      credentials: true
    }
  });

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

  const port = Number(process.env.CHORDV_API_PORT ?? 3000);
  await app.listen(port);
  console.log(`ChordV API listening on http://localhost:${port}/api`);
}

bootstrap();
