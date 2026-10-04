import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadConfig } from "./common/config";
import { requestLogMiddleware } from "./common/http-pipeline";

/** Shared by main.ts and the test harness so tests exercise the real HTTP configuration. */
export async function createApp(): Promise<NestExpressApplication> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: config.NODE_ENV === "test" ? false : ["error", "warn"],
    bodyParser: false,
  });
  app.setGlobalPrefix("api/v1");
  app.disable("x-powered-by");
  app.set("trust proxy", config.NODE_ENV === "production" ? 1 : false);
  app.use(requestLogMiddleware);
  app.useBodyParser("json", { limit: "256kb" });
  app.use(helmet());
  const origins = config.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  app.enableCors({ origin: origins, credentials: false, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], maxAge: 600 });
  return app;
}
