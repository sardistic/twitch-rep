import type { FastifyInstance } from "fastify";
import { apiError } from "@chatterscope/contracts";
import { z } from "zod";
import { parseUserSearchInput } from "@chatterscope/auth";
import {
  connectOrganizationChannel,
  getMembershipsForUser,
  listOrganizationChannels,
  recordAuditEvent,
  setOrganizationChannelEnabled,
  upsertTwitchChannel,
  upsertTwitchUser,
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
   * Watches any public channel via anonymous IRC — no broadcaster
   * authorization needed for public chat observation. Admin-only.
   */
  app.post("/v1/channels/watch", { preHandler: requireSession(deps) }, async (request, reply) => {
    if (!pool) {
      return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
    }
    if (!twitch) {
      return reply
        .status(503)
        .send(apiError("TWITCH_NOT_CONFIGURED", "Twitch API is required to resolve channels."));
    }
    const parsed = z.object({ channel: z.string().min(1) }).safeParse(request.body);
    const ref = parsed.success ? parseUserSearchInput(parsed.data.channel) : null;
    if (!ref) {
      return reply
        .status(400)
        .send(apiError("INVALID_INPUT", "Provide a channel login, URL, or numeric ID."));
    }
    const memberships = await getMembershipsForUser(pool, request.session!.appUserId);
    const admin = memberships.find((m) => m.role === "owner" || m.role === "admin");
    if (!admin) {
      return reply
        .status(403)
        .send(apiError("FORBIDDEN", "Only owners and admins may watch channels."));
    }
    const helixUser =
      ref.kind === "id"
        ? await twitch.getUserById(ref.twitchUserId)
        : await twitch.getUserByLogin(ref.login);
    if (!helixUser) {
      return reply.status(404).send(apiError("USER_NOT_FOUND", "No such Twitch channel."));
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
    await upsertTwitchChannel(pool, {
      twitchChannelId: helixUser.twitchUserId,
      login: helixUser.login,
      displayName: helixUser.displayName,
    });
    await connectOrganizationChannel(
      pool,
      admin.organizationId,
      helixUser.twitchUserId,
      request.session!.appUserId,
    );
    deps.watchChannel?.(helixUser.login);
    await recordAuditEvent(pool, {
      organizationId: admin.organizationId,
      actorUserId: request.session!.appUserId,
      action: "channel.watch",
      targetType: "twitch_channel",
      targetId: helixUser.twitchUserId,
    });
    return reply.send({
      channel: { twitchChannelId: helixUser.twitchUserId, login: helixUser.login },
      transport: "irc",
    });
  });

  app.delete<{ Params: { twitchChannelId: string } }>(
    "/v1/channels/:twitchChannelId",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) {
        return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
      }
      const memberships = await getMembershipsForUser(pool, request.session!.appUserId);
      const adminOrgs = memberships
        .filter((m) => m.role === "owner" || m.role === "admin")
        .map((m) => m.organizationId);
      const disabled = await setOrganizationChannelEnabled(
        pool,
        adminOrgs,
        request.params.twitchChannelId,
        false,
      );
      if (!disabled) {
        return reply.status(404).send(apiError("NOT_FOUND", "Channel not found in your orgs."));
      }
      deps.unwatchChannelById?.(request.params.twitchChannelId);
      await recordAuditEvent(pool, {
        organizationId: null,
        actorUserId: request.session!.appUserId,
        action: "channel.unwatch",
        targetType: "twitch_channel",
        targetId: request.params.twitchChannelId,
      });
      return reply.send({ ok: true });
    },
  );

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
