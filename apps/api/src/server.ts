import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { Env } from "@chatterscope/config";
import type { FetchLike, TwitchOAuthConfig } from "@chatterscope/auth";
import { getAppUserById, type AppUser, type PostgresPool } from "@chatterscope/postgres";
import { buildHealthReport, type HealthChecks } from "./health.js";
import type { SessionStore } from "./auth/session.js";
import type { TwitchApi } from "./twitch/client.js";
import type { ChatIngestor } from "./eventsub/ingest.js";
import type { ProfileService } from "./services/profile.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTwitchUserRoutes } from "./routes/twitch-users.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerEventSubRoutes } from "./eventsub/routes.js";
import { registerChatterRoutes } from "./routes/chatters.js";
import { registerNoteRoutes } from "./routes/notes.js";
import { DASHBOARD_PAGE } from "./web/page.js";

export const API_VERSION = "0.1.0";

export type ServerDeps = {
  env: Env;
  checks: HealthChecks;
  pool: PostgresPool | null;
  sessions: SessionStore;
  twitch: TwitchApi | null;
  oauthConfig: TwitchOAuthConfig | null;
  encryptionKey: Buffer | null;
  fetchImpl: FetchLike;
  getAppUser: (id: string) => Promise<AppUser | null>;
  ingestor: ChatIngestor | null;
  profiles: ProfileService | null;
};

export function buildDefaultGetAppUser(pool: PostgresPool | null) {
  return async (id: string): Promise<AppUser | null> => (pool ? getAppUserById(pool, id) : null);
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { env, checks } = deps;
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    genReqId: () => crypto.randomUUID(),
  });

  void app.register(fastifyCookie);

  app.get("/", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(DASHBOARD_PAGE);
  });

  const healthHandler = async (reply: {
    status: (code: number) => { send: (body: unknown) => unknown };
  }) => {
    const report = await buildHealthReport(checks, API_VERSION);
    return reply.status(report.status === "ok" ? 200 : 503).send(report);
  };

  app.get("/healthz", async (_request, reply) => healthHandler(reply));
  app.get("/v1/health", async (_request, reply) => healthHandler(reply));

  registerAuthRoutes(app, deps);
  registerTwitchUserRoutes(app, deps);
  registerChannelRoutes(app, deps);
  registerEventSubRoutes(app, deps);
  registerChatterRoutes(app, deps);
  registerNoteRoutes(app, deps);

  return app;
}
