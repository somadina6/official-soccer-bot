import { z } from "zod";

const boolFromString = z
  .string()
  .transform((v) => v === "true" || v === "1")
  .pipe(z.boolean());

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  PUBLISHING_ENABLED: boolFromString.default("false"),
  DRY_RUN: boolFromString.default("true"),
  BANTER_TONE: z.enum(["neutral", "playful", "spicy"]).default("playful"),

  SPORTSAPI_ENABLED: boolFromString.default("true"),
  SPORTSAPI_KEY: z.string().min(1),
  SPORTSAPI_BASE_URL: z
    .string()
    .url()
    .default("https://api.sportsapipro.com/v2/football"),
  SPORTSAPI_WS_URL: z
    .string()
    .url()
    .default("wss://api.sportsapipro.com/v2/football/ws"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_DB_URL: z.string().min(1),
  SUPABASE_STORAGE_BUCKET: z.string().min(1),

  OPENAI_API_KEY: z.string().min(1),
  OPENAI_TEXT_MODEL: z.string().default("gpt-5.6-luna"),
  OPENAI_IMAGE_MODEL: z.string().default("gpt-image-2"),
  IMAGE_PROVIDER: z.enum(["openai", "replicate"]).default("openai"),
  REPLICATE_API_TOKEN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1).optional(),
  ),
  REPLICATE_IMAGE_MODEL: z.string().min(1).default("xai/grok-imagine-image"),
  REPLICATE_IMAGE_ASPECT_RATIO: z.string().min(1).default("3:2"),
  REPLICATE_IMAGE_RESOLUTION: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.enum(["1k", "2k"]).optional(),
  ),
  IMAGE_GENERATION_DEADLINE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30_000),
  IMAGE_OUTPUT_COMPRESSION: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(85),

  TWITTER_CONSUMER_KEY: z.string().min(1),
  TWITTER_CONSUMER_SECRET: z.string().min(1),
  TWITTER_ACCESS_TOKEN: z.string().min(1),
  TWITTER_ACCESS_SECRET: z.string().min(1),

  MAX_POSTS_PER_15_MIN: z.coerce.number().int().positive().default(12),
  MAX_POSTS_PER_DAY: z.coerce.number().int().positive().default(100),

  SENTRY_DSN: z.string().default(""),
}).superRefine((env, ctx) => {
  if (env.IMAGE_PROVIDER === "replicate" && !env.REPLICATE_API_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REPLICATE_API_TOKEN"],
      message: "required when IMAGE_PROVIDER is replicate",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/**
 * Validates an env-shaped object without caching. Used by loadEnv() and tests.
 */
export function parseEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const parsed = EnvSchema.safeParse({
    ...source,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}

/**
 * Validates process.env once at boot. Throws with a readable list of the
 * missing/invalid variables so misconfiguration fails fast, before any
 * network connection is opened. Secret values are never included in errors.
 */
export function loadEnv(): Env {
  if (cached) return cached;
  cached = parseEnv();
  return cached;
}
