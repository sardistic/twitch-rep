import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { Env } from "@chatterscope/config";
import type { FetchLike, TwitchOAuthConfig } from "@chatterscope/auth";
import { getAppUserById, type AppUser, type PostgresPool } from "@chatterscope/postgres";
import { buildHealthReport, type HealthChecks } from "./health.js";
import type { SessionStore } from "./auth/session.js";
import type { TwitchApi } from "./twitch/client.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTwitchUserRoutes } from "./routes/twitch-users.js";

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
};

export function buildDefaultGetAppUser(pool: PostgresPool | null) {
  return async (id: string): Promise<AppUser | null> => (pool ? getAppUserById(pool, id) : null);
}

const LANDING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatterScope</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #0e0e10; color: #efeff1;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 40rem; padding: 2rem; text-align: center; }
  h1 { font-size: 2.2rem; margin-bottom: 0.25rem; }
  h1 span { color: #a970ff; }
  p.tag { color: #adadb8; margin-top: 0; }
  .services { display: flex; gap: 0.75rem; justify-content: center; margin: 1.5rem 0; flex-wrap: wrap; }
  .svc { border: 1px solid #2f2f35; border-radius: 0.5rem; padding: 0.5rem 1rem; background: #18181b; }
  .svc b { display: block; font-size: 0.8rem; color: #adadb8; font-weight: 500; }
  .state-ok { color: #00f593; }
  .state-error { color: #f55353; }
  .state-unknown { color: #adadb8; }
  .signin { display: inline-block; margin-top: 0.5rem; padding: 0.6rem 1.4rem; border-radius: 0.5rem;
            background: #9147ff; color: #fff; text-decoration: none; font-weight: 600; }
  .signin:hover { background: #a970ff; }
  footer { color: #66666e; font-size: 0.8rem; margin-top: 2rem; }
</style>
</head>
<body>
<main>
  <h1>Chatter<span>Scope</span></h1>
  <p class="tag">Evidence-based chat context for Twitch moderators. Pilot deployment &mdash; dashboard coming soon.</p>
  <div class="services" id="services">
    <div class="svc"><b>postgres</b><span class="state-unknown">checking&hellip;</span></div>
    <div class="svc"><b>clickhouse</b><span class="state-unknown">checking&hellip;</span></div>
    <div class="svc"><b>redis</b><span class="state-unknown">checking&hellip;</span></div>
  </div>
  <a class="signin" href="/v1/auth/twitch/login">Sign in with Twitch</a>
  <footer id="version"></footer>
</main>
<script>
  fetch("/healthz").then(function (r) { return r.json(); }).then(function (h) {
    var boxes = document.querySelectorAll(".svc");
    ["postgres", "clickhouse", "redis"].forEach(function (name, i) {
      var state = h.services[name] || "unknown";
      var span = boxes[i].querySelector("span");
      span.textContent = state;
      span.className = "state-" + state;
    });
    document.getElementById("version").textContent =
      "v" + h.version + " \\u00b7 " + h.timestamp;
  }).catch(function () {
    document.querySelectorAll(".svc span").forEach(function (s) {
      s.textContent = "unreachable"; s.className = "state-error";
    });
  });
</script>
</body>
</html>`;

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
    return reply.type("text/html; charset=utf-8").send(LANDING_PAGE);
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

  return app;
}
