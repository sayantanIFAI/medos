import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { raw, type RequestHandler } from "express";
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
  // Raw file bodies (PNG/JPEG/PDF) are accepted only on the patient file upload route, only from callers that sent credentials
  // (so anonymous requests cannot make the server buffer large bodies), and only up to the size limit.
  const rawFiles = raw({ type: ["image/png", "image/jpeg", "application/pdf"], limit: "6mb" });
  const authedOnly: RequestHandler = (req, res, next) => (req.method === "POST" && req.headers.authorization && /^\/api\/v1\/patients\/[^/]+\/files\/?$/.test(req.path) ? rawFiles(req, res, next) : next());
  app.use(authedOnly);
  app.use(helmet());
  const origins = config.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  app.enableCors({ origin: origins, credentials: false, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], maxAge: 600 });
  return app;
}
