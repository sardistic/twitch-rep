import { describe, expect, it } from "vitest";
import { ConfigError, loadEnv } from "./index.js";

const validEnv = {
  POSTGRES_URL: "postgresql://chatterscope:chatterscope@localhost:5432/chatterscope",
  CLICKHOUSE_URL: "http://localhost:8123",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = loadEnv(validEnv);
    expect(env.NODE_ENV).toBe("development");
    expect(env.CLICKHOUSE_DATABASE).toBe("chatterscope");
    expect(env.MESSAGE_RETENTION_DAYS).toBe(365);
    expect(env.ALLOW_PRIVATE_PROVIDER_NETWORKS).toBe(false);
    expect(env.API_PORT).toBe(4000);
  });

  it("rejects a missing POSTGRES_URL", () => {
    expect(() => loadEnv({ ...validEnv, POSTGRES_URL: undefined })).toThrow(ConfigError);
  });

  it("rejects a non-postgres POSTGRES_URL", () => {
    expect(() => loadEnv({ ...validEnv, POSTGRES_URL: "mysql://localhost/x" })).toThrow(
      /POSTGRES_URL/,
    );
  });

  it("rejects a non-redis REDIS_URL", () => {
    expect(() => loadEnv({ ...validEnv, REDIS_URL: "http://localhost:6379" })).toThrow(/REDIS_URL/);
  });

  it("coerces numeric strings", () => {
    const env = loadEnv({ ...validEnv, MESSAGE_RETENTION_DAYS: "30", ROLE_RECENT_DAYS: "7" });
    expect(env.MESSAGE_RETENTION_DAYS).toBe(30);
    expect(env.ROLE_RECENT_DAYS).toBe(7);
  });

  it("enforces required secrets without providing defaults", () => {
    expect(() => loadEnv(validEnv, { requireSecrets: ["SESSION_SECRET"] })).toThrow(
      /SESSION_SECRET/,
    );
    const env = loadEnv(
      { ...validEnv, SESSION_SECRET: "a".repeat(64) },
      { requireSecrets: ["SESSION_SECRET"] },
    );
    expect(env.SESSION_SECRET).toBe("a".repeat(64));
  });

  it("treats empty-string secrets as unset", () => {
    const env = loadEnv({ ...validEnv, SESSION_SECRET: "", TWITCH_CLIENT_ID: "" });
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(() =>
      loadEnv({ ...validEnv, SESSION_SECRET: "" }, { requireSecrets: ["SESSION_SECRET"] }),
    ).toThrow(/SESSION_SECRET/);
  });

  it("rejects short secrets", () => {
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: "short" })).toThrow(ConfigError);
  });
});
