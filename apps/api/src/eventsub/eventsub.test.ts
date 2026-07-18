import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@chatterscope/clickhouse";
import { verifyEventSubSignature } from "./signature.js";
import { chatMessageEventSchema, normalizeChatMessageEvent } from "./normalize.js";
import { ChatIngestor, MemoryDedupStore } from "./ingest.js";

const SECRET = "test-eventsub-secret";

function sign(messageId: string, timestamp: string, body: string): string {
  return (
    "sha256=" +
    createHmac("sha256", SECRET).update(messageId).update(timestamp).update(body).digest("hex")
  );
}

describe("verifyEventSubSignature", () => {
  const now = () => new Date("2026-07-18T12:00:00Z");
  const timestamp = "2026-07-18T11:59:00Z";

  it("accepts a valid signature", () => {
    const body = '{"hello":"world"}';
    const check = verifyEventSubSignature(
      { messageId: "m1", timestamp, signature: sign("m1", timestamp, body) },
      body,
      SECRET,
      now,
    );
    expect(check.valid).toBe(true);
  });

  it("rejects a tampered body", () => {
    const check = verifyEventSubSignature(
      { messageId: "m1", timestamp, signature: sign("m1", timestamp, "{}") },
      '{"tampered":true}',
      SECRET,
      now,
    );
    expect(check).toEqual({ valid: false, reason: "bad_signature" });
  });

  it("rejects timestamps outside the replay window", () => {
    const stale = "2026-07-18T11:00:00Z";
    const body = "{}";
    const check = verifyEventSubSignature(
      { messageId: "m1", timestamp: stale, signature: sign("m1", stale, body) },
      body,
      SECRET,
      now,
    );
    expect(check).toEqual({ valid: false, reason: "stale_timestamp" });
  });

  it("rejects missing headers", () => {
    const check = verifyEventSubSignature(
      { messageId: undefined, timestamp, signature: "x" },
      "{}",
      SECRET,
      now,
    );
    expect(check).toEqual({ valid: false, reason: "missing_headers" });
  });
});

const sampleEvent = {
  broadcaster_user_id: "900000001",
  broadcaster_user_login: "alpha_channel_demo",
  broadcaster_user_name: "AlphaChannelDemo",
  chatter_user_id: "900000004",
  chatter_user_login: "helpful_mod_demo",
  chatter_user_name: "HelpfulModDemo",
  message_id: "msg-001",
  message: { text: "hello chat" },
  color: "#00FF00",
  badges: [
    { set_id: "moderator", id: "1" },
    { set_id: "subscriber", id: "12", info: "14" },
    { set_id: "some_unknown_badge", id: "1" },
  ],
  reply: null,
};

describe("normalizeChatMessageEvent", () => {
  it("maps the EventSub payload to the normalized contract", () => {
    const event = chatMessageEventSchema.parse(sampleEvent);
    const normalized = normalizeChatMessageEvent(event, "2026-07-18T12:00:00.000Z", sampleEvent);
    expect(normalized.messageId).toBe("msg-001");
    expect(normalized.twitchChannelId).toBe("900000001");
    expect(normalized.twitchUserId).toBe("900000004");
    expect(normalized.badges).toHaveLength(3);
    expect(normalized.badges[1]).toEqual({ setId: "subscriber", id: "12", info: "14" });
    expect(normalized.source).toBe("eventsub");
    expect(normalized.provider).toBe("native");
  });
});

function fakeClickHouse() {
  const inserts: Array<{ table: string; values: unknown[] }> = [];
  const client = {
    insert: async (args: { table: string; values: unknown[] }) => {
      inserts.push({ table: args.table, values: args.values });
    },
  } as unknown as ClickHouseClient;
  return { client, inserts };
}

describe("ChatIngestor", () => {
  function normalized() {
    const event = chatMessageEventSchema.parse(sampleEvent);
    return normalizeChatMessageEvent(event, "2026-07-18T12:00:00.000Z", sampleEvent);
  }

  it("writes the message and expands only recognized badges into role observations", async () => {
    const { client, inserts } = fakeClickHouse();
    const ingestor = new ChatIngestor(client, "chatterscope", new MemoryDedupStore());
    const result = await ingestor.ingest(normalized());

    expect(result).toEqual({ status: "ingested", roleObservations: 2 });
    expect(inserts[0]!.table).toBe("chatterscope.chat_messages");
    const row = inserts[0]!.values[0] as Record<string, unknown>;
    expect(row.badges).toEqual({ moderator: "1", subscriber: "12", some_unknown_badge: "1" });
    expect(row.moderator).toBe(true);
    expect(row.subscriber).toBe(true);

    expect(inserts[1]!.table).toBe("chatterscope.role_observations");
    const roles = (inserts[1]!.values as Array<{ role_name: string }>).map((v) => v.role_name);
    expect(roles.sort()).toEqual(["moderator", "subscriber"]);
  });

  it("deduplicates by source and message id", async () => {
    const { client, inserts } = fakeClickHouse();
    const ingestor = new ChatIngestor(client, "chatterscope", new MemoryDedupStore());
    await ingestor.ingest(normalized());
    const second = await ingestor.ingest(normalized());
    expect(second).toEqual({ status: "duplicate" });
    expect(inserts).toHaveLength(2);
    expect(ingestor.counters).toEqual({ ingested: 1, deduplicated: 1, roleObservations: 2 });
  });
});
