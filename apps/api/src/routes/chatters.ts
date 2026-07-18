import type { FastifyInstance } from "fastify";
import { apiError } from "@chatterscope/contracts";
import {
  getMembershipsForUser,
  listOrganizationChannels,
  recordAuditEvent,
} from "@chatterscope/postgres";
import { requireSession } from "../plugins/auth-guard.js";
import type { ServerDeps } from "../server.js";

const ID_PATTERN = /^\d{1,20}$/;

export function registerChatterRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { pool, profiles } = deps;

  async function authorizedChannelIds(appUserId: string): Promise<string[]> {
    const memberships = await getMembershipsForUser(pool!, appUserId);
    const ids = new Set<string>();
    for (const membership of memberships) {
      for (const channel of await listOrganizationChannels(pool!, membership.organizationId)) {
        if (channel.enabled) ids.add(channel.twitchChannelId);
      }
    }
    return [...ids];
  }

  app.get<{ Params: { twitchUserId: string } }>(
    "/v1/chatters/:twitchUserId/profile",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool || !profiles) {
        return reply.status(503).send(apiError("NOT_CONFIGURED", "Profile service unavailable."));
      }
      const { twitchUserId } = request.params;
      if (!ID_PATTERN.test(twitchUserId)) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Twitch user IDs are numeric."));
      }
      const profile = await profiles.getProfile(twitchUserId);
      await recordAuditEvent(pool, {
        organizationId: null,
        actorUserId: request.session!.appUserId,
        action: "chatter.profile_view",
        targetType: "twitch_user",
        targetId: twitchUserId,
      });
      return reply.send(profile);
    },
  );

  app.get<{
    Params: { twitchUserId: string };
    Querystring: {
      channelId?: string;
      from?: string;
      to?: string;
      limit?: string;
      cursor?: string;
    };
  }>(
    "/v1/chatters/:twitchUserId/messages",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool || !profiles) {
        return reply.status(503).send(apiError("NOT_CONFIGURED", "Profile service unavailable."));
      }
      const { twitchUserId } = request.params;
      if (!ID_PATTERN.test(twitchUserId)) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Twitch user IDs are numeric."));
      }
      const limit = Math.min(Math.max(Number(request.query.limit ?? 25) || 25, 1), 100);
      const channels = await authorizedChannelIds(request.session!.appUserId);
      const result = await profiles.getMessages({
        twitchUserId,
        authorizedChannelIds: channels,
        channelId: request.query.channelId,
        from: request.query.from,
        to: request.query.to,
        limit,
        cursor: request.query.cursor,
      });
      await recordAuditEvent(pool, {
        organizationId: null,
        actorUserId: request.session!.appUserId,
        action: "chatter.messages_view",
        targetType: "twitch_user",
        targetId: twitchUserId,
        metadata: { count: result.messages.length },
      });
      return reply.send(result);
    },
  );

  app.get<{ Params: { twitchUserId: string } }>(
    "/v1/chatters/:twitchUserId/roles",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool || !profiles) {
        return reply.status(503).send(apiError("NOT_CONFIGURED", "Profile service unavailable."));
      }
      const { twitchUserId } = request.params;
      if (!ID_PATTERN.test(twitchUserId)) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Twitch user IDs are numeric."));
      }
      const profile = await profiles.getProfile(twitchUserId);
      return reply.send({ roles: profile.roles, warnings: profile.warnings });
    },
  );
}
