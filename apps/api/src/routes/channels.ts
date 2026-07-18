import type { FastifyInstance } from "fastify";
import { apiError } from "@chatterscope/contracts";
import {
  connectOrganizationChannel,
  getMembershipsForUser,
  listOrganizationChannels,
  recordAuditEvent,
  upsertTwitchChannel,
} from "@chatterscope/postgres";
import { requireSession } from "../plugins/auth-guard.js";
import type { ServerDeps } from "../server.js";

export function registerChannelRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { env, pool, twitch } = deps;

  app.get("/v1/channels", { preHandler: requireSession(deps) }, async (request, reply) => {
    if (!pool) {
      return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
    }
    const memberships = await getMembershipsForUser(pool, request.session!.appUserId);
    const channels = await Promise.all(
      memberships.map(async (m) => ({
        organizationId: m.organizationId,
        organizationName: m.organizationName,
        channels: await listOrganizationChannels(pool, m.organizationId),
      })),
    );
    return reply.send({ organizations: channels });
  });

  /**
   * Connects the signed-in user's own channel: registers it for the user's
   * organization and creates the channel.chat.message EventSub subscription
   * (requires the user to have granted user:read:chat at sign-in).
   */
  app.post("/v1/channels/connect", { preHandler: requireSession(deps) }, async (request, reply) => {
    if (!pool || !twitch || !env.TWITCH_EVENTSUB_SECRET) {
      return reply
        .status(503)
        .send(apiError("NOT_CONFIGURED", "Twitch or EventSub is not configured."));
    }
    const session = request.session!;
    const user = await deps.getAppUser(session.appUserId);
    if (!user) {
      return reply.status(401).send(apiError("SESSION_INVALID", "Session user no longer exists."));
    }
    const memberships = await getMembershipsForUser(pool, user.id);
    const owned = memberships.find((m) => m.role === "owner" || m.role === "admin");
    if (!owned) {
      return reply
        .status(403)
        .send(apiError("FORBIDDEN", "Only owners and admins may connect channels."));
    }

    await upsertTwitchChannel(pool, {
      twitchChannelId: user.twitchUserId,
      login: user.login,
      displayName: user.displayName,
    });
    await connectOrganizationChannel(pool, owned.organizationId, user.twitchUserId, user.id);

    const callbackUrl = `${env.API_ORIGIN}/v1/eventsub/webhook`;
    let subscription: { subscriptionId: string; status: string };
    try {
      subscription = await twitch.createChatMessageSubscription(
        user.twitchUserId,
        user.twitchUserId,
        callbackUrl,
        env.TWITCH_EVENTSUB_SECRET,
      );
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("already exists") || message.includes("409")) {
        subscription = { subscriptionId: "existing", status: "already_subscribed" };
      } else {
        request.log.error({ err: error }, "eventsub subscription failed");
        return reply.status(502).send(apiError("EVENTSUB_SUBSCRIBE_FAILED", message));
      }
    }

    await recordAuditEvent(pool, {
      organizationId: owned.organizationId,
      actorUserId: user.id,
      action: "channel.connect",
      targetType: "twitch_channel",
      targetId: user.twitchUserId,
      metadata: { subscription },
    });

    return reply.send({
      channel: { twitchChannelId: user.twitchUserId, login: user.login },
      subscription,
    });
  });
}
