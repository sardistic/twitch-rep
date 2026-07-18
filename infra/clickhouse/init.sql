-- Applied automatically on first container start.
-- Retention here matches the MESSAGE_RETENTION_DAYS=365 default; deployments
-- with different retention should run the schema through
-- @chatterscope/clickhouse ensureSchema(), which parameterizes the TTL.

CREATE DATABASE IF NOT EXISTS chatterscope;

CREATE TABLE IF NOT EXISTS chatterscope.chat_messages
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
TTL event_date + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS chatterscope.role_observations
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
TTL event_date + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192;
