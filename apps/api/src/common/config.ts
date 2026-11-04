import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  STORAGE_DIR: z.string().default("./.local/storage"),
  /**
   * The remote AI host (a free Kaggle GPU notebook, see apps/ai-host): prescription reading, speech recognition and the language model all
   * run THERE, never on the machine that runs MedOS. One base URL and one token serve all three. Unset: those features say they are not connected.
   */
  AI_REMOTE_URL: z.string().url().optional(),
  AI_REMOTE_TOKEN: z.string().min(16).optional(),
  AI_REMOTE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180_000).default(60_000),
  /** The language model's own address when it is not the remote AI host (an Ollama-compatible /api/chat). Usually unset. */
  ASSISTANT_LLM_URL: z.string().url().optional(),
  ASSISTANT_LLM_MODEL: z.string().default("qwen2.5:7b"),
  ASSISTANT_LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(45_000),
  SCRYPT_LOG_N: z.coerce.number().int().min(10).max(20).default(15),
});

export type AppConfig = z.infer<typeof schema>;

export const CONFIG = Symbol("APP_CONFIG");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration: ${fields}`);
  }
  return parsed.data;
}
