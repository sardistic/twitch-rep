import type { ClickHouseClient } from "@chatterscope/clickhouse";
import {
  DEFAULT_BADGE_ROLE_MAP,
  normalizedChatMessageSchema,
  type NormalizedChatMessage,
} from "@chatterscope/contracts";

export interface DedupStore {
  /** Returns true when the key was newly claimed (i.e. not a duplicate). */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}

export type IngestCounters = {
  ingested: number;
  deduplicated: number;
  roleObservations: number;
};

export type IngestResult =
  { status: "ingested"; roleObservations: number } | { status: "duplicate" };

const DEDUP_TTL_SECONDS = 24 * 60 * 60;

function toClickHouseDateTime(iso: string): string {
  // ClickHouse DateTime64 input: "YYYY-MM-DD HH:MM:SS.mmm"
  return iso
    .replace("T", " ")
    .replace(/Z$/, "")
    .replace(/([.]\d{3})\d*$/, "$1");
}

export class ChatIngestor {
  readonly counters: IngestCounters = { ingested: 0, deduplicated: 0, roleObservations: 0 };

  constructor(
    private readonly clickhouse: ClickHouseClient,
    private readonly database: string,
    private readonly dedup: DedupStore,
    private readonly badgeRoleMap: Readonly<Record<string, string>> = DEFAULT_BADGE_ROLE_MAP,
  ) {}

  async ingest(message: NormalizedChatMessage): Promise<IngestResult> {
    const validated = normalizedChatMessageSchema.parse(message);

    const fresh = await this.dedup.claim(
      `ingest:${validated.source}:${validated.messageId}`,
      DEDUP_TTL_SECONDS,
    );
    if (!fresh) {
      this.counters.deduplicated += 1;
      return { status: "duplicate" };
    }

    const sentAt = toClickHouseDateTime(validated.sentAt);
    const badgesMap: Record<string, string> = {};
    const badgeInfoMap: Record<string, string> = {};
    for (const badge of validated.badges) {
      badgesMap[badge.setId] = badge.id;
      if (badge.info !== undefined) badgeInfoMap[badge.setId] = badge.info;
    }

    await this.clickhouse.insert({
      table: `${this.database}.chat_messages`,
      format: "JSONEachRow",
      values: [
        {
          message_id: validated.messageId,
          twitch_channel_id: validated.twitchChannelId,
          twitch_user_id: validated.twitchUserId,
          user_login: validated.userLogin,
          display_name: validated.displayName,
          message_text: validated.messageText,
          badges: badgesMap,
          badge_info: badgeInfoMap,
          color: validated.color ?? null,
          reply_parent_message_id: validated.replyParentMessageId ?? null,
          first_message: validated.firstMessage,
          returning_chatter: validated.returningChatter,
          subscriber: "subscriber" in badgesMap || "founder" in badgesMap,
          moderator: "moderator" in badgesMap || "broadcaster" in badgesMap,
          source: validated.source,
          provider: validated.provider,
          raw_payload: JSON.stringify(validated.raw ?? {}),
          sent_at: sentAt,
        },
      ],
    });

    // Recognized badges become role observations; unknown badges stay in the
    // stored badge map but are never interpreted as roles.
    const observations = validated.badges
      .filter((badge) => badge.setId in this.badgeRoleMap)
      .map((badge) => ({
        twitch_channel_id: validated.twitchChannelId,
        twitch_user_id: validated.twitchUserId,
        role_name: this.badgeRoleMap[badge.setId]!,
        role_value: badge.id,
        message_id: validated.messageId,
        source: validated.source,
        provider: validated.provider,
        observed_at: sentAt,
      }));
    if (observations.length > 0) {
      await this.clickhouse.insert({
        table: `${this.database}.role_observations`,
        format: "JSONEachRow",
        values: observations,
      });
    }

    this.counters.ingested += 1;
    this.counters.roleObservations += observations.length;
    return { status: "ingested", roleObservations: observations.length };
  }
}

type RedisLike = {
  set(key: string, value: string, ex: "EX", seconds: number, nx: "NX"): Promise<"OK" | null>;
};

export class RedisDedupStore implements DedupStore {
  constructor(private readonly redis: RedisLike) {}

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(key, "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }
}

/** Test-only dedup store. */
export class MemoryDedupStore implements DedupStore {
  private readonly keys = new Set<string>();

  async claim(key: string): Promise<boolean> {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}
