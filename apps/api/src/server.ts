import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import type { Env } from "@chatterscope/config";
import type { FetchLike, TwitchOAuthConfig } from "@chatterscope/auth";
import { getAppUserById, type AppUser, type PostgresPool } from "@chatterscope/postgres";
import { buildHealthReport, type HealthChecks } from "./health.js";
import type { SessionStore } from "./auth/session.js";
import type { TwitchApi } from "./twitch/client.js";
import type { ChatIngestor } from "./eventsub/ingest.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerTwitchUserRoutes } from "./routes/twitch-users.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerEventSubRoutes } from "./eventsub/routes.js";

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
  <div id="account"><a class="signin" href="/v1/auth/twitch/login">Sign in with Twitch</a></div>
  <div id="tools" style="display:none">
    <form id="searchForm" style="margin:1rem 0">
      <input id="searchInput" placeholder="Twitch login, URL, or numeric ID"
             style="padding:0.55rem 0.8rem;border-radius:0.5rem;border:1px solid #2f2f35;background:#18181b;color:#efeff1;width:16rem">
      <button class="signin" style="border:0;cursor:pointer" type="submit">Look up</button>
    </form>
    <div id="result"></div>
    <button id="connectBtn" class="signin" style="border:0;cursor:pointer;background:#2f2f35">Connect my channel (start chat ingestion)</button>
    <div id="connectResult" style="color:#adadb8;font-size:0.85rem;margin-top:0.5rem"></div>
  </div>
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

  fetch("/v1/me").then(function (r) { return r.ok ? r.json() : null; }).then(function (me) {
    if (!me) return;
    document.getElementById("account").innerHTML =
      "<p>Signed in as <b>" + me.user.displayName.replace(/[<>&]/g, "") + "</b> \\u00b7 " +
      (me.organizations[0] ? me.organizations[0].name.replace(/[<>&]/g, "") : "") + "</p>";
    document.getElementById("tools").style.display = "block";
  }).catch(function () {});

  document.getElementById("searchForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var q = document.getElementById("searchInput").value;
    var out = document.getElementById("result");
    out.textContent = "Looking up\\u2026";
    fetch("/v1/twitch/users/resolve?input=" + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { out.textContent = data.error.message; return; }
        var u = data.user;
        out.innerHTML =
          '<div class="svc" style="display:inline-block;text-align:left;margin-top:0.5rem">' +
          (u.profileImageUrl ? '<img src="' + u.profileImageUrl + '" width="48" style="border-radius:50%;float:left;margin-right:0.75rem">' : "") +
          "<b>" + u.displayName.replace(/[<>&]/g, "") + "</b> (" + u.login.replace(/[<>&]/g, "") + ")<br>" +
          "ID " + u.twitchUserId + " \\u00b7 created " + (u.accountCreatedAt || "unknown").slice(0, 10) +
          "<br><span style='color:#66666e'>source: " + data.source + "</span></div>";
      })
      .catch(function () { out.textContent = "Lookup failed."; });
  });

  document.getElementById("connectBtn").addEventListener("click", function () {
    var out = document.getElementById("connectResult");
    out.textContent = "Connecting\\u2026";
    fetch("/v1/channels/connect", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        out.textContent = data.error
          ? data.error.message
          : "Connected " + data.channel.login + " \\u00b7 subscription " + data.subscription.status;
      })
      .catch(function () { out.textContent = "Connect failed."; });
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
  registerChannelRoutes(app, deps);
  registerEventSubRoutes(app, deps);

  return app;
}
