import { describe, expect, it } from "vitest";
import type { Env } from "@chatterscope/config";
import type { PostgresPool } from "@chatterscope/postgres";
import { buildServer, type ServerDeps } from "../server.js";
import { MemorySessionStore } from "../auth/session.js";
import { SESSION_COOKIE } from "../plugins/auth-guard.js";

const env = {
  NODE_ENV: "test",
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:4000",
  API_PORT: 4000,
  POSTGRES_URL: "postgresql://x@localhost/x",
  CLICKHOUSE_URL: "http://localhost:8123",
  CLICKHOUSE_DATABASE: "chatterscope",
  CLICKHOUSE_USERNAME: "default",
  CLICKHOUSE_PASSWORD: "",
  REDIS_URL: "redis://localhost:6379",
  MESSAGE_RETENTION_DAYS: 365,
  ROLE_RECENT_DAYS: 30,
  ALLOW_PRIVATE_PROVIDER_NETWORKS: false,
  LOG_LEVEL: "error",
} as Env;

const ok = async () => {};

function buildDeps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    env,
    checks: { postgres: ok, clickhouse: ok, redis: ok },
    pool: null,
    sessions: new MemorySessionStore(),
    twitch: null,
    oauthConfig: null,
    encryptionKey: null,
    fetchImpl: fetch,
    getAppUser: async () => null,
    ...overrides,
  };
}

describe("auth routes", () => {
  it("login returns 503 when Twitch is not configured", async () => {
    const app = buildServer(buildDeps());
    const response = await app.inject({ method: "GET", url: "/v1/auth/twitch/login" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("TWITCH_NOT_CONFIGURED");
  });

  it("login redirects to Twitch with a stored state when configured", async () => {
    const sessions = new MemorySessionStore();
    const app = buildServer(
      buildDeps({
        sessions,
        twitch: {
          getUserByLogin: async () => null,
          getUserById: async () => null,
          getUserForToken: async () => null,
        },
        oauthConfig: {
          clientId: "cid",
          clientSecret: "cs",
          redirectUri: "http://localhost:4000/v1/auth/twitch/callback",
        },
      }),
    );
    const response = await app.inject({ method: "GET", url: "/v1/auth/twitch/login" });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.hostname).toBe("id.twitch.tv");
    const state = location.searchParams.get("state")!;
    expect(await sessions.consumeOauthState(state)).toBe(true);
  });

  it("callback rejects unknown state", async () => {
    const app = buildServer(
      buildDeps({
        pool: {} as PostgresPool,
        encryptionKey: Buffer.alloc(32),
        twitch: {
          getUserByLogin: async () => null,
          getUserById: async () => null,
          getUserForToken: async () => null,
        },
        oauthConfig: {
          clientId: "cid",
          clientSecret: "cs",
          redirectUri: "http://localhost:4000/v1/auth/twitch/callback",
        },
      }),
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/twitch/callback?code=abc&state=never-issued",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("OAUTH_STATE_INVALID");
  });

  it("/v1/me requires a session", async () => {
    const app = buildServer(buildDeps());
    const response = await app.inject({ method: "GET", url: "/v1/me" });
    expect(response.statusCode).toBe(401);
  });

  it("logout rejects cross-origin requests (CSRF)", async () => {
    const sessions = new MemorySessionStore();
    const sessionId = await sessions.create({
      appUserId: "u1",
      twitchUserId: "1",
      createdAt: new Date().toISOString(),
    });
    const app = buildServer(buildDeps({ sessions }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      cookies: { [SESSION_COOKIE]: sessionId },
      headers: { origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("twitch user routes", () => {
  it("resolve requires a session", async () => {
    const app = buildServer(buildDeps());
    const response = await app.inject({ method: "GET", url: "/v1/twitch/users/resolve?login=x" });
    expect(response.statusCode).toBe(401);
  });

  it("resolve rejects invalid input", async () => {
    const sessions = new MemorySessionStore();
    const sessionId = await sessions.create({
      appUserId: "u1",
      twitchUserId: "1",
      createdAt: new Date().toISOString(),
    });
    const app = buildServer(buildDeps({ sessions, pool: {} as PostgresPool }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/twitch/users/resolve?input=not%20a%20login!!",
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_INPUT");
  });

  it("user-by-id rejects non-numeric ids", async () => {
    const sessions = new MemorySessionStore();
    const sessionId = await sessions.create({
      appUserId: "u1",
      twitchUserId: "1",
      createdAt: new Date().toISOString(),
    });
    const app = buildServer(buildDeps({ sessions, pool: {} as PostgresPool }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/twitch/users/notanid",
      cookies: { [SESSION_COOKIE]: sessionId },
    });
    expect(response.statusCode).toBe(400);
  });
});
