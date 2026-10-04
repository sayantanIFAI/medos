"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
exports.loadConfig = loadConfig;
const zod_1 = require("zod");
const schema = zod_1.z.object({
    NODE_ENV: zod_1.z.enum(["development", "test", "production"]).default("development"),
    PORT: zod_1.z.coerce.number().int().default(4000),
    DATABASE_URL: zod_1.z.string().url(),
    JWT_ACCESS_SECRET: zod_1.z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL_SECONDS: zod_1.z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: zod_1.z.coerce.number().int().positive().default(7 * 24 * 3600),
    LOGIN_MAX_FAILURES: zod_1.z.coerce.number().int().positive().default(5),
    LOGIN_LOCK_SECONDS: zod_1.z.coerce.number().int().positive().default(900),
    RATE_LIMIT_ENABLED: zod_1.z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
    CORS_ORIGINS: zod_1.z.string().default("http://localhost:3000"),
    SCRYPT_LOG_N: zod_1.z.coerce.number().int().min(10).max(20).default(15),
});
exports.CONFIG = Symbol("APP_CONFIG");
function loadConfig(env = process.env) {
    const parsed = schema.safeParse(env);
    if (!parsed.success) {
        const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
        throw new Error(`Invalid configuration: ${fields}`);
    }
    return parsed.data;
}
//# sourceMappingURL=config.js.map