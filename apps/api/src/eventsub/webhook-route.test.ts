import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Env } from "@chatterscope/config";
import type { ClickHouseClient } from "@chatterscope/clickhouse";
import { buildServer, type ServerDeps } from "../server.js";
import { MemorySessionStore } from "../auth/session.js";
import { ChatIngestor, MemoryDedupStore } from "./ingest.js";

const SECRET = "webhook-test-secret";

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
  TWITCH_EVENTSUB_SECRET: SECRET,
  MESSAGE_RETENTION_DAYS: 365,
  ROLE_RECENT_DAYS: 30,
  ALLOW_PRIVATE_PROVIDER_NETWORKS: false,
  LOG_LEVEL: "error",
} as Env;

function signedHeaders(body: string, messageType: string) {
  const messageId = "wh-" + Math.random().toString(36).slice(2);
  const timestamp = new Date().toISOString();
  const signature =
    "sha256=" +
    createHmac("sha256", SECRET).update(messageId).update(timestamp).update(body).digest("hex");
  return {
    "content-type": "application/json",
    "twitch-eventsub-message-id": messageId,
    "twitch-eventsub-message-timestamp": timestamp,
    "twitch-eventsub-message-signature": signature,
    "twitch-eventsub-message-type": messageType,
  };
}

function buildApp() {
  const inserts: Array<{ table: string }> = [];
  const clickhouse = {
    insert: async (args: { table: string }) => {
      inserts.push({ table: args.table });
    },
  } as unknown as ClickHouseClient;
  const deps: ServerDeps = {
    env,
    checks: { postgres: async () => {}, clickhouse: async () => {}, redis: async () => {} },
    pool: null,
    sessions: new MemorySessionStore(),
    twitch: null,
    oauthConfig: null,
    encryptionKey: null,
    fetchImpl: fetch,
    getAppUser: async () => null,
    ingestor: new ChatIngestor(clickhouse, "chatterscope", new MemoryDedupStore()),
  };
  return { app: buildServer(deps), inserts };
}

describe("POST /v1/eventsub/webhook", () => {
  it("answers the verification challenge with plain text", async () => {
    const { app } = buildApp();
    const body = JSON.stringify({
      challenge: "challenge-token",
      subscription: { id: "s1", type: "channel.chat.message", status: "pending" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/eventsub/webhook",
      headers: signedHeaders(body, "webhook_callback_verification"),
      body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("challenge-token");
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("rejects bad signatures with 403", async () => {
    const { app } = buildApp();
    const body = JSON.stringify({
      subscription: { id: "s1", type: "channel.chat.message", status: "enabled" },
    });
    const headers = signedHeaders(body, "notification");
    headers["twitch-eventsub-message-signature"] = "sha256=" + "0".repeat(64);
    const response = await app.inject({
      method: "POST",
      url: "/v1/eventsub/webhook",
      headers,
      body,
    });
    expect(response.statusCode).toBe(403);
  });

  it("ingests a chat message notification exactly once", async () => {
    const { app, inserts } = buildApp();
    const makeBody = () =>
      JSON.stringify({
        subscription: { id: "s1", type: "channel.chat.message", status: "enabled" },
        event: {
          broadcaster_user_id: "900000001",
          broadcaster_user_login: "alpha_channel_demo",
          broadcaster_user_name: "AlphaChannelDemo",
          chatter_user_id: "900000004",
          chatter_user_login: "helpful_mod_demo",
          chatter_user_name: "HelpfulModDemo",
          message_id: "msg-dup-test",
          message: { text: "hi" },
          badges: [{ set_id: "vip", id: "1" }],
        },
      });
    const first = await app.inject({
      method: "POST",
      url: "/v1/eventsub/webhook",
      headers: signedHeaders(makeBody(), "notification"),
      body: makeBody(),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: "POST",
      url: "/v1/eventsub/webhook",
      headers: signedHeaders(makeBody(), "notification"),
      body: makeBody(),
    });
    expect(second.statusCode).toBe(200);
    // 2 inserts from the first delivery (message + role observation), none from the duplicate.
    expect(inserts).toHaveLength(2);
  });

  it("acknowledges revocations", async () => {
    const { app } = buildApp();
    const body = JSON.stringify({
      subscription: { id: "s1", type: "channel.chat.message", status: "authorization_revoked" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/eventsub/webhook",
      headers: signedHeaders(body, "revocation"),
      body,
    });
    expect(response.statusCode).toBe(200);
  });
});
