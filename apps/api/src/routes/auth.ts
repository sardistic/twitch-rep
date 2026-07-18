import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { apiError } from "@chatterscope/contracts";
import { buildAuthorizeUrl, encryptSecret, exchangeAuthorizationCode } from "@chatterscope/auth";
import {
  createOrganizationWithOwner,
  getMembershipsForUser,
  recordAuditEvent,
  saveOauthGrant,
  upsertAppUser,
  upsertTwitchUser,
} from "@chatterscope/postgres";
import type { ServerDeps } from "../server.js";
import { SESSION_COOKIE, requireSession } from "../plugins/auth-guard.js";

export function registerAuthRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { env, pool, sessions, twitch, oauthConfig, encryptionKey } = deps;

  app.get("/v1/auth/twitch/login", async (_request, reply) => {
    if (!oauthConfig || !twitch) {
      return reply
        .status(503)
        .send(apiError("TWITCH_NOT_CONFIGURED", "Twitch OAuth credentials are not configured."));
    }
    const state = randomBytes(24).toString("hex");
    await sessions.saveOauthState(state);
    return reply.redirect(buildAuthorizeUrl(oauthConfig, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/v1/auth/twitch/callback",
    async (request, reply) => {
      if (!oauthConfig || !twitch || !pool || !encryptionKey) {
        return reply
          .status(503)
          .send(apiError("TWITCH_NOT_CONFIGURED", "Twitch OAuth credentials are not configured."));
      }
      const { code, state, error } = request.query;
      if (error) {
        return reply.status(400).send(apiError("OAUTH_DENIED", `Twitch reported: ${error}`));
      }
      if (!code || !state || !(await sessions.consumeOauthState(state))) {
        return reply
          .status(400)
          .send(apiError("OAUTH_STATE_INVALID", "Missing or unrecognized OAuth state."));
      }

      const tokens = await exchangeAuthorizationCode(oauthConfig, code, deps.fetchImpl);
      const helixUser = await twitch.getUserForToken(tokens.accessToken);
      if (!helixUser) {
        return reply
          .status(502)
          .send(apiError("TWITCH_USER_UNRESOLVED", "Twitch did not return the signed-in user."));
      }

      await upsertTwitchUser(pool, {
        twitchUserId: helixUser.twitchUserId,
        login: helixUser.login,
        displayName: helixUser.displayName,
        accountCreatedAt: helixUser.accountCreatedAt,
        profileImageUrl: helixUser.profileImageUrl,
        broadcasterType: helixUser.broadcasterType,
        description: helixUser.description,
      });
      const appUser = await upsertAppUser(pool, {
        twitchUserId: helixUser.twitchUserId,
        login: helixUser.login,
        displayName: helixUser.displayName,
        profileImageUrl: helixUser.profileImageUrl,
      });

      let memberships = await getMembershipsForUser(pool, appUser.id);
      if (memberships.length === 0) {
        await createOrganizationWithOwner(pool, `${helixUser.displayName}'s Team`, appUser.id);
        memberships = await getMembershipsForUser(pool, appUser.id);
      }

      if (tokens.refreshToken) {
        await saveOauthGrant(pool, {
          organizationId: memberships[0]!.organizationId,
          twitchUserId: helixUser.twitchUserId,
          accessTokenCiphertext: encryptSecret(tokens.accessToken, encryptionKey),
          refreshTokenCiphertext: encryptSecret(tokens.refreshToken, encryptionKey),
          scopes: tokens.scopes,
          expiresAt: tokens.expiresAt,
        });
      }

      await recordAuditEvent(pool, {
        organizationId: memberships[0]!.organizationId,
        actorUserId: appUser.id,
        action: "auth.sign_in",
        targetType: "app_user",
        targetId: appUser.id,
      });

      const sessionId = await sessions.create({
        appUserId: appUser.id,
        twitchUserId: helixUser.twitchUserId,
        createdAt: new Date().toISOString(),
      });
      reply.setCookie(SESSION_COOKIE, sessionId, {
        path: "/",
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60,
      });
      return reply.redirect("/");
    },
  );

  app.post("/v1/auth/logout", { preHandler: requireSession(deps) }, async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) await sessions.destroy(sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.send({ ok: true });
  });

  app.get("/v1/me", { preHandler: requireSession(deps) }, async (request, reply) => {
    if (!pool) {
      return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
    }
    const session = request.session!;
    const user = await deps.getAppUser(session.appUserId);
    if (!user) {
      return reply.status(401).send(apiError("SESSION_INVALID", "Session user no longer exists."));
    }
    const memberships = await getMembershipsForUser(pool, user.id);
    return reply.send({
      user: {
        id: user.id,
        twitchUserId: user.twitchUserId,
        login: user.login,
        displayName: user.displayName,
        profileImageUrl: user.profileImageUrl,
      },
      organizations: memberships.map((m) => ({
        id: m.organizationId,
        name: m.organizationName,
        role: m.role,
      })),
    });
  });
}
