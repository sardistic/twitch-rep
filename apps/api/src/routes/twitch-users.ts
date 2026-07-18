import type { FastifyInstance } from "fastify";
import { apiError, type ResolveUserResponse } from "@chatterscope/contracts";
import { parseUserSearchInput } from "@chatterscope/auth";
import {
  getTwitchUserById,
  getTwitchUserByLogin,
  upsertTwitchUser,
  type CachedTwitchUser,
} from "@chatterscope/postgres";
import type { HelixUser } from "../twitch/client.js";
import { requireSession } from "../plugins/auth-guard.js";
import type { ServerDeps } from "../server.js";

const CACHE_FRESH_MS = 6 * 60 * 60 * 1000;

function toContractUser(user: CachedTwitchUser) {
  return {
    twitchUserId: user.twitchUserId,
    login: user.login,
    displayName: user.displayName,
    accountCreatedAt: user.accountCreatedAt?.toISOString() ?? null,
    profileImageUrl: user.profileImageUrl,
    broadcasterType: user.broadcasterType,
    description: user.description,
    fetchedAt: user.fetchedAt.toISOString(),
  };
}

export function registerTwitchUserRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { pool, twitch } = deps;

  async function cacheHelixUser(helixUser: HelixUser): Promise<CachedTwitchUser> {
    return upsertTwitchUser(pool!, {
      twitchUserId: helixUser.twitchUserId,
      login: helixUser.login,
      displayName: helixUser.displayName,
      accountCreatedAt: helixUser.accountCreatedAt,
      profileImageUrl: helixUser.profileImageUrl,
      broadcasterType: helixUser.broadcasterType,
      description: helixUser.description,
    });
  }

  async function resolve(
    input: { kind: "login"; login: string } | { kind: "id"; twitchUserId: string },
  ): Promise<ResolveUserResponse | null> {
    const cached =
      input.kind === "login"
        ? await getTwitchUserByLogin(pool!, input.login)
        : await getTwitchUserById(pool!, input.twitchUserId);
    if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_FRESH_MS) {
      return { user: toContractUser(cached), source: "cache" };
    }
    if (!twitch) {
      // No Twitch credentials: serve stale cache rather than nothing.
      return cached ? { user: toContractUser(cached), source: "cache" } : null;
    }
    const helixUser =
      input.kind === "login"
        ? await twitch.getUserByLogin(input.login)
        : await twitch.getUserById(input.twitchUserId);
    if (!helixUser) {
      return cached ? { user: toContractUser(cached), source: "cache" } : null;
    }
    return { user: toContractUser(await cacheHelixUser(helixUser)), source: "twitch_api" };
  }

  app.get<{ Querystring: { login?: string; input?: string } }>(
    "/v1/twitch/users/resolve",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) {
        return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
      }
      const raw = request.query.input ?? request.query.login ?? "";
      const parsed = parseUserSearchInput(raw);
      if (!parsed) {
        return reply
          .status(400)
          .send(apiError("INVALID_INPUT", "Provide a Twitch login, profile URL, or numeric ID."));
      }
      const resolved = await resolve(parsed);
      if (!resolved) {
        return reply.status(404).send(apiError("USER_NOT_FOUND", "No Twitch user matched."));
      }
      return reply.send(resolved);
    },
  );

  app.get<{ Params: { twitchUserId: string } }>(
    "/v1/twitch/users/:twitchUserId",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) {
        return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
      }
      if (!/^\d{1,20}$/.test(request.params.twitchUserId)) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Twitch user IDs are numeric."));
      }
      const resolved = await resolve({ kind: "id", twitchUserId: request.params.twitchUserId });
      if (!resolved) {
        return reply.status(404).send(apiError("USER_NOT_FOUND", "No Twitch user matched."));
      }
      return reply.send(resolved);
    },
  );
}
