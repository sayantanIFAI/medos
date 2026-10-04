"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const core_1 = require("@nestjs/core");
const helmet_1 = __importDefault(require("helmet"));
const app_module_1 = require("./app.module");
const config_1 = require("./common/config");
const http_pipeline_1 = require("./common/http-pipeline");
/** Shared by main.ts and the test harness so tests exercise the real HTTP configuration. */
async function createApp() {
    const config = (0, config_1.loadConfig)();
    const app = await core_1.NestFactory.create(app_module_1.AppModule, {
        logger: config.NODE_ENV === "test" ? false : ["error", "warn"],
        bodyParser: false,
    });
    app.setGlobalPrefix("api/v1");
    app.disable("x-powered-by");
    app.set("trust proxy", config.NODE_ENV === "production" ? 1 : false);
    app.use(http_pipeline_1.requestLogMiddleware);
    app.useBodyParser("json", { limit: "256kb" });
    app.use((0, helmet_1.default)());
    const origins = config.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
    app.enableCors({ origin: origins, credentials: false, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], maxAge: 600 });
    return app;
}
//# sourceMappingURL=bootstrap.js.map