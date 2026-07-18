import { createClient, type ClickHouseClient } from "@clickhouse/client";

export * from "./queries.js";

export type { ClickHouseClient };

export type ClickHouseConfig = {
  url: string;
  database: string;
  username: string;
  password: string;
  messageRetentionDays: number;
};

export function createClickHouse(config: ClickHouseConfig): ClickHouseClient {
  return createClient({
    url: config.url,
    database: config.database,
    username: config.username,
    password: config.password,
    request_timeout: 10_000,
  });
}

export async function checkClickHouse(client: ClickHouseClient): Promise<void> {
  const result = await client.ping();
  if (!result.success) {
    throw new Error(
      `ClickHouse ping failed: ${"error" in result ? result.error.message : "unknown"}`,
    );
  }
}

/**
 * Schema statements with configurable retention. Retention must stay
 * configurable per the retention policy; the TTL clause itself must not be
 * removed because production deployments require bounded retention.
 */
export function schemaStatements(database: string, messageRetentionDays: number): string[] {
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`Invalid ClickHouse database name: ${database}`);
  }
  if (!Number.isInteger(messageRetentionDays) || messageRetentionDays < 1) {
    throw new Error(`messageRetentionDays must be a positive integer, got ${messageRetentionDays}`);
  }
  return [
    `CREATE DATABASE IF NOT EXISTS ${database}`,
    `CREATE TABLE IF NOT EXISTS ${database}.chat_messages
(
    event_date Date DEFAULT toDate(sent_at),
    message_id String,
    twitch_channel_id String,
    twitch_user_id String,
    user_login LowCardinality(String),
    display_name String,
    message_text String,
    badges Map(LowCardinality(String), String),
    badge_info Map(LowCardinality(String), String),
    color Nullable(String),
    reply_parent_message_id Nullable(String),
    first_message Bool,
    returning_chatter Bool,
    subscriber Bool,
    moderator Bool,
    source LowCardinality(String),
    provider LowCardinality(String),
    raw_payload String,
    sent_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (twitch_channel_id, twitch_user_id, sent_at, message_id)
TTL event_date + INTERVAL ${messageRetentionDays} DAY DELETE
SETTINGS index_granularity = 8192`,
    `CREATE TABLE IF NOT EXISTS ${database}.role_observations
(
    event_date Date DEFAULT toDate(observed_at),
    twitch_channel_id String,
    twitch_user_id String,
    role_name LowCardinality(String),
    role_value String,
    message_id String,
    source LowCardinality(String),
    provider LowCardinality(String),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (twitch_user_id, twitch_channel_id, role_name, observed_at, message_id)
TTL event_date + INTERVAL ${messageRetentionDays} DAY DELETE
SETTINGS index_granularity = 8192`,
  ];
}

export async function ensureSchema(
  client: ClickHouseClient,
  config: ClickHouseConfig,
): Promise<void> {
  for (const statement of schemaStatements(config.database, config.messageRetentionDays)) {
    await client.command({ query: statement });
  }
}
