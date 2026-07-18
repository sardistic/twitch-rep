import type { ClickHouseClient } from "@clickhouse/client";

export type ChatterSummaryRow = {
  channels_observed: string;
  messages_observed: string;
  first_observed_at: string | null;
  last_observed_at: string | null;
};

export type ChannelActivityRow = {
  twitch_channel_id: string;
  message_count: string;
  first_observed_at: string;
  last_observed_at: string;
};

export type RoleObservationAggRow = {
  twitch_channel_id: string;
  role_name: string;
  first_observed_at: string;
  last_observed_at: string;
  observation_count: string;
  latest_source: string;
  latest_provider: string;
};

export type MessageRow = {
  message_id: string;
  twitch_channel_id: string;
  user_login: string;
  message_text: string;
  badges: Record<string, string>;
  sent_at: string;
  source: string;
  provider: string;
};

async function rows<T>(client: ClickHouseClient, query: string, params: Record<string, unknown>) {
  const result = await client.query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });
  return result.json<T>();
}

export async function chatterSummary(
  client: ClickHouseClient,
  database: string,
  twitchUserId: string,
): Promise<ChatterSummaryRow | null> {
  const data = await rows<ChatterSummaryRow>(
    client,
    `SELECT
       uniqExact(twitch_channel_id) AS channels_observed,
       count() AS messages_observed,
       toString(min(sent_at)) AS first_observed_at,
       toString(max(sent_at)) AS last_observed_at
     FROM ${database}.chat_messages
     WHERE twitch_user_id = {userId:String}`,
    { userId: twitchUserId },
  );
  const row = data[0];
  return row && row.messages_observed !== "0" ? row : null;
}

export async function channelActivity(
  client: ClickHouseClient,
  database: string,
  twitchUserId: string,
): Promise<ChannelActivityRow[]> {
  return rows<ChannelActivityRow>(
    client,
    `SELECT
       twitch_channel_id,
       count() AS message_count,
       toString(min(sent_at)) AS first_observed_at,
       toString(max(sent_at)) AS last_observed_at
     FROM ${database}.chat_messages
     WHERE twitch_user_id = {userId:String}
     GROUP BY twitch_channel_id
     ORDER BY last_observed_at DESC`,
    { userId: twitchUserId },
  );
}

export async function roleObservationAggregates(
  client: ClickHouseClient,
  database: string,
  twitchUserId: string,
): Promise<RoleObservationAggRow[]> {
  return rows<RoleObservationAggRow>(
    client,
    `SELECT
       twitch_channel_id,
       role_name,
       toString(min(observed_at)) AS first_observed_at,
       toString(max(observed_at)) AS last_observed_at,
       count() AS observation_count,
       argMax(source, observed_at) AS latest_source,
       argMax(provider, observed_at) AS latest_provider
     FROM ${database}.role_observations
     WHERE twitch_user_id = {userId:String}
     GROUP BY twitch_channel_id, role_name
     ORDER BY last_observed_at DESC`,
    { userId: twitchUserId },
  );
}

export type MessagesPage = { messages: MessageRow[]; nextCursor: string | null };

export function encodeCursor(sentAt: string, messageId: string): string {
  return Buffer.from(JSON.stringify([sentAt, messageId]), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { sentAt: string; messageId: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      /^[\d\- :.]{19,26}$/.test(parsed[0])
    ) {
      return { sentAt: parsed[0], messageId: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}

export async function chatterMessages(
  client: ClickHouseClient,
  database: string,
  options: {
    twitchUserId: string;
    channelIds?: string[] | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  },
): Promise<MessagesPage> {
  const limit = Math.min(Math.max(options.limit, 1), 100);
  const conditions = ["twitch_user_id = {userId:String}"];
  const params: Record<string, unknown> = { userId: options.twitchUserId, limit: limit + 1 };
  if (options.channelIds && options.channelIds.length > 0) {
    conditions.push("twitch_channel_id IN {channelIds:Array(String)}");
    params.channelIds = options.channelIds;
  }
  if (options.from) {
    conditions.push("sent_at >= parseDateTime64BestEffort({from:String}, 3)");
    params.from = options.from;
  }
  if (options.to) {
    conditions.push("sent_at <= parseDateTime64BestEffort({to:String}, 3)");
    params.to = options.to;
  }
  if (options.cursor) {
    const decoded = decodeCursor(options.cursor);
    if (decoded) {
      conditions.push(
        "(sent_at, message_id) < (parseDateTime64BestEffort({cursorSentAt:String}, 3), {cursorMessageId:String})",
      );
      params.cursorSentAt = decoded.sentAt;
      params.cursorMessageId = decoded.messageId;
    }
  }
  const data = await rows<MessageRow>(
    client,
    `SELECT
       message_id, twitch_channel_id, user_login, message_text, badges,
       toString(sent_at) AS sent_at, source, provider
     FROM ${database}.chat_messages
     WHERE ${conditions.join(" AND ")}
     ORDER BY sent_at DESC, message_id DESC
     LIMIT {limit:UInt32}`,
    params,
  );
  const hasMore = data.length > limit;
  const page = hasMore ? data.slice(0, limit) : data;
  const last = page[page.length - 1];
  return {
    messages: page,
    nextCursor: hasMore && last ? encodeCursor(last.sent_at, last.message_id) : null,
  };
}
