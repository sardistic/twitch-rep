import { Redis } from "ioredis";
import { loadDotenv, loadEnv } from "@chatterscope/config";
import { deriveKey, type TwitchOAuthConfig } from "@chatterscope/auth";
import { checkClickHouse, createClickHouse } from "@chatterscope/clickhouse";
import { checkPostgres, createPool } from "@chatterscope/postgres";
import { buildDefaultGetAppUser, buildServer } from "./server.js";
import { RedisSessionStore } from "./auth/session.js";
import { HelixClient } from "./twitch/client.js";
import { ChatIngestor, RedisDedupStore } from "./eventsub/ingest.js";
import { DefaultProfileService } from "./services/profile.js";
import { TwitchIrcClient } from "./irc/client.js";
import {
  listAllEnabledChannelLogins,
  upsertTwitchUserIdentity,
  upsertTwitchChannel,
  getChannelMeta,
} from "@chatterscope/postgres";

loadDotenv();

const env = loadEnv(process.env, { requireSecrets: ["SESSION_SECRET", "ENCRYPTION_KEY"] });

const pool = createPool(env.POSTGRES_URL);
const clickhouse = createClickHouse({
  url: env.CLICKHOUSE_URL,
  database: env.CLICKHOUSE_DATABASE,
  username: env.CLICKHOUSE_USERNAME,
  password: env.CLICKHOUSE_PASSWORD,
  messageRetentionDays: env.MESSAGE_RETENTION_DAYS,
});
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
  retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
});
redis.on("error", (error) => {
  // Errors surface via health checks; this handler prevents an unhandled
  // 'error' event from crashing the process while Redis is down.
  void error;
});

const oauthConfig: TwitchOAuthConfig | null =
  env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET && env.TWITCH_REDIRECT_URI
    ? {
        clientId: env.TWITCH_CLIENT_ID,
        clientSecret: env.TWITCH_CLIENT_SECRET,
        redirectUri: env.TWITCH_REDIRECT_URI,
      }
    : null;

const ingestor = new ChatIngestor(clickhouse, env.CLICKHOUSE_DATABASE, new RedisDedupStore(redis));

// Identity cache upserts are throttled to once per user/channel per hour to
// avoid a Postgres write per chat line.
const seenIdentities = new Map<string, number>();
function shouldUpsert(key: string): boolean {
  const now = Date.now();
  const last = seenIdentities.get(key);
  if (last && now - last < 60 * 60 * 1000) return false;
  seenIdentities.set(key, now);
  if (seenIdentities.size > 50_000) seenIdentities.clear();
  return true;
}

const irc = new TwitchIrcClient({
  onMessage: (message, channelLogin) => {
    void (async () => {
      try {
        await ingestor.ingest(message);
        if (shouldUpsert(`u:${message.twitchUserId}`)) {
          await upsertTwitchUserIdentity(pool, {
            twitchUserId: message.twitchUserId,
            login: message.userLogin,
            displayName: message.displayName,
          });
        }
        if (shouldUpsert(`c:${message.twitchChannelId}`)) {
          await upsertTwitchChannel(pool, {
            twitchChannelId: message.twitchChannelId,
            login: channelLogin,
            displayName: channelLogin,
          });
        }
        await redis.del(`profile:${message.twitchUserId}`);
      } catch (error) {
        app.log.error({ err: error }, "irc ingest failed");
      }
    })();
  },
  onLog: (level, event, detail) => {
    // app may not be constructed yet on the first connect attempt
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    app?.log[level]({ irc: detail }, event);
  },
});

const app = buildServer({
  env,
  checks: {
    postgres: () => checkPostgres(pool),
    clickhouse: () => checkClickHouse(clickhouse),
    redis: async () => {
      const pong = await redis.ping();
      if (pong !== "PONG") throw new Error(`unexpected redis ping response: ${pong}`);
    },
  },
  pool,
  sessions: new RedisSessionStore(redis),
  twitch: oauthConfig ? new HelixClient(oauthConfig.clientId, oauthConfig.clientSecret) : null,
  oauthConfig,
  encryptionKey: deriveKey(env.ENCRYPTION_KEY!),
  fetchImpl: fetch,
  getAppUser: buildDefaultGetAppUser(pool),
  ingestor,
  profiles: new DefaultProfileService(pool, clickhouse, env.CLICKHOUSE_DATABASE, {
    get: (key) => redis.get(key),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, "EX", ttlSeconds);
    },
  }),
  profileCacheDelete: async (key) => {
    await redis.del(key);
  },
  kv: {
    get: (key) => redis.get(key),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, "EX", ttlSeconds);
    },
  },
  watchChannel: (login) => irc.join(login),
  unwatchChannelById: (twitchChannelId) => {
    void getChannelMeta(pool, [twitchChannelId]).then((meta) => {
      const channel = meta.get(twitchChannelId);
      if (channel) irc.part(channel.login);
    });
  },
});

if (!oauthConfig) {
  app.log.warn("Twitch OAuth is not configured; sign-in routes will return 503");
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "shutting down");
  irc.stop();
  await app.close();
  await Promise.allSettled([pool.end(), clickhouse.close(), redis.quit()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  const watchList = await listAllEnabledChannelLogins(pool);
  irc.start(watchList);
  app.log.info({ channels: watchList }, "irc watch list loaded");
} catch (error) {
  app.log.error(error, "failed to start API server");
  process.exit(1);
}
