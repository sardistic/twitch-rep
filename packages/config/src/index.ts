import { z } from "zod";

export { loadDotenv } from "./dotenv.js";

const booleanString = z.enum(["true", "false"]).transform((value) => value === "true");

// Empty string (e.g. `SESSION_SECRET=` in a .env file) is treated as unset;
// validation then happens at the point a service requires the secret.
const optionalSecret = (schema: z.ZodString) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/**
 * Environment schema shared by all backend services. Services validate at
 * startup and crash immediately on invalid configuration.
 *
 * Secrets (SESSION_SECRET, ENCRYPTION_KEY, TWITCH_*) are optional here because
 * Milestone 1 services do not use them yet; `requireSecrets` lets later
 * milestones opt in without weakening validation for services that need them.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  API_ORIGIN: z.string().url().default("http://localhost:4000"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  POSTGRES_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
      message: "POSTGRES_URL must be a postgres:// or postgresql:// URL",
    }),
  CLICKHOUSE_URL: z.string().url(),
  CLICKHOUSE_DATABASE: z.string().min(1).default("chatterscope"),
  CLICKHOUSE_USERNAME: z.string().min(1).default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  REDIS_URL: z
    .string()
    .url()
    .refine((value) => value.startsWith("redis://") || value.startsWith("rediss://"), {
      message: "REDIS_URL must be a redis:// or rediss:// URL",
    }),

  SESSION_SECRET: optionalSecret(z.string().min(32)),
  ENCRYPTION_KEY: optionalSecret(z.string().min(32)),
  TWITCH_CLIENT_ID: optionalSecret(z.string().min(1)),
  TWITCH_CLIENT_SECRET: optionalSecret(z.string().min(1)),
  TWITCH_REDIRECT_URI: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().url().optional(),
  ),
  TWITCH_EVENTSUB_SECRET: optionalSecret(z.string().min(10)),

  MESSAGE_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),
  ROLE_RECENT_DAYS: z.coerce.number().int().min(1).default(30),
  ALLOW_PRIVATE_PROVIDER_NETWORKS: booleanString.default("false"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type LoadEnvOptions = {
  /** Secrets that must be present for this service, e.g. ["SESSION_SECRET"]. */
  requireSecrets?: Array<
    | "SESSION_SECRET"
    | "ENCRYPTION_KEY"
    | "TWITCH_CLIENT_ID"
    | "TWITCH_CLIENT_SECRET"
    | "TWITCH_REDIRECT_URI"
    | "TWITCH_EVENTSUB_SECRET"
  >;
};

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
  options: LoadEnvOptions = {},
): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment configuration — ${details}`);
  }
  for (const key of options.requireSecrets ?? []) {
    if (parsed.data[key] === undefined) {
      throw new ConfigError(`Missing required secret ${key}; generate it, no default is provided`);
    }
  }
  return parsed.data;
}
