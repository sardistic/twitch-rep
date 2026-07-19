import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiError, type NormalizedChatMessage } from "@chatterscope/contracts";
import { parseUserSearchInput } from "@chatterscope/auth";
import {
  RustlogCompatibleProvider,
  validateProviderBaseUrl,
  type ChatLogProvider,
} from "@chatterscope/providers";
import {
  createProvider,
  deleteProvider,
  finishSyncRun,
  getMembershipsForUser,
  getProviderForOrgs,
  getTwitchUserByLogin,
  listProvidersForOrgs,
  recordAuditEvent,
  startSyncRun,
  type ProviderRecord,
} from "@chatterscope/postgres";
import { requireSession } from "../plugins/auth-guard.js";
import type { ServerDeps } from "../server.js";

const createProviderSchema = z.object({
  name: z.string().min(1).max(100),
  providerType: z.literal("rustlog"),
  baseUrl: z.string().url(),
  organizationId: z.string().uuid().optional(),
});

const syncSchema = z.object({
  user: z.string().min(1),
  channel: z.string().min(1),
  limit: z.number().int().min(1).max(1000).optional(),
});

export function registerProviderRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { env, pool, ingestor } = deps;

  function buildProvider(record: ProviderRecord): ChatLogProvider {
    return new RustlogCompatibleProvider({
      id: record.id,
      displayName: record.name,
      baseUrl: record.baseUrl ?? "",
      allowPrivateNetworks: env.ALLOW_PRIVATE_PROVIDER_NETWORKS,
      fetchImpl: deps.fetchImpl,
    });
  }

  async function requireAdminOrgs(appUserId: string) {
    const memberships = await getMembershipsForUser(pool!, appUserId);
    return {
      all: memberships.map((m) => m.organizationId),
      admin: memberships
        .filter((m) => m.role === "owner" || m.role === "admin")
        .map((m) => m.organizationId),
    };
  }

  app.get("/v1/providers", { preHandler: requireSession(deps) }, async (request, reply) => {
    if (!pool) return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "No database."));
    const orgs = await requireAdminOrgs(request.session!.appUserId);
    const providers = await listProvidersForOrgs(pool, orgs.all);
    return reply.send({
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        providerType: p.providerType,
        baseUrl: p.baseUrl,
        enabled: p.enabled,
        createdAt: p.createdAt.toISOString(),
      })),
    });
  });

  app.post("/v1/providers", { preHandler: requireSession(deps) }, async (request, reply) => {
    if (!pool) return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "No database."));
    const parsed = createProviderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(apiError("INVALID_INPUT", "name, providerType=rustlog, and baseUrl are required."));
    }
    const orgs = await requireAdminOrgs(request.session!.appUserId);
    const organizationId = parsed.data.organizationId ?? orgs.admin[0];
    if (!organizationId || !orgs.admin.includes(organizationId)) {
      return reply
        .status(403)
        .send(apiError("FORBIDDEN", "Only owners and admins may add providers."));
    }
    try {
      validateProviderBaseUrl(parsed.data.baseUrl, env.ALLOW_PRIVATE_PROVIDER_NETWORKS);
    } catch (error) {
      return reply.status(400).send(apiError("INVALID_BASE_URL", (error as Error).message));
    }
    const provider = await createProvider(pool, {
      organizationId,
      providerType: parsed.data.providerType,
      name: parsed.data.name,
      baseUrl: parsed.data.baseUrl,
    });
    await recordAuditEvent(pool, {
      organizationId,
      actorUserId: request.session!.appUserId,
      action: "provider.create",
      targetType: "provider",
      targetId: provider.id,
      metadata: { baseUrl: parsed.data.baseUrl },
    });
    return reply.status(201).send({ provider: { id: provider.id, name: provider.name } });
  });

  app.post<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/test",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "No database."));
      const orgs = await requireAdminOrgs(request.session!.appUserId);
      const record = await getProviderForOrgs(pool, request.params.providerId, orgs.all);
      if (!record) return reply.status(404).send(apiError("NOT_FOUND", "Provider not found."));
      try {
        await buildProvider(record).testConnection();
        return reply.send({ ok: true });
      } catch (error) {
        return reply.status(502).send(apiError("PROVIDER_TEST_FAILED", (error as Error).message));
      }
    },
  );

  app.post<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/sync",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool || !ingestor) {
        return reply.status(503).send(apiError("NOT_CONFIGURED", "Ingestion unavailable."));
      }
      const parsed = syncSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(apiError("INVALID_INPUT", "user and channel are required (login or numeric id)."));
      }
      const orgs = await requireAdminOrgs(request.session!.appUserId);
      const record = await getProviderForOrgs(pool, request.params.providerId, orgs.admin);
      if (!record) {
        return reply
          .status(404)
          .send(apiError("NOT_FOUND", "Provider not found in your admin organizations."));
      }
      const userRef = parseUserSearchInput(parsed.data.user);
      const channelRef = parseUserSearchInput(parsed.data.channel);
      if (!userRef || !channelRef) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Unrecognized user or channel."));
      }

      const provider = buildProvider(record);
      const runId = await startSyncRun(pool, record.id);
      let read = 0;
      let written = 0;
      try {
        const result = await provider.queryMessages({
          user:
            userRef.kind === "id"
              ? { twitchUserId: userRef.twitchUserId }
              : { login: userRef.login },
          channel:
            channelRef.kind === "id"
              ? { twitchChannelId: channelRef.twitchUserId }
              : { login: channelRef.login },
          limit: parsed.data.limit ?? 500,
        });
        read = result.messages.length;
        for (const message of result.messages) {
          // Provider messages usually carry logins, not ids; resolve through
          // the identity cache and skip messages we cannot attribute safely.
          const userId =
            message.user.twitchUserId ??
            (message.user.login
              ? (await getTwitchUserByLogin(pool, message.user.login))?.twitchUserId
              : undefined);
          const channelId =
            message.channel.twitchChannelId ??
            (message.channel.login
              ? (await getTwitchUserByLogin(pool, message.channel.login))?.twitchUserId
              : undefined);
          if (!userId || !channelId) continue;
          const normalized: NormalizedChatMessage = {
            messageId: message.messageId ?? `${record.id}:${message.providerRecordId}`,
            twitchChannelId: channelId,
            twitchUserId: userId,
            userLogin: message.user.login ?? "unknown",
            displayName: message.user.login ?? "unknown",
            messageText: message.messageText,
            badges: message.badges,
            firstMessage: false,
            returningChatter: false,
            sentAt: message.sentAt,
            source: "external",
            provider: record.name,
            raw: message.raw,
          };
          const outcome = await ingestor.ingest(normalized);
          if (outcome.status === "ingested") written += 1;
        }
        await finishSyncRun(pool, runId, {
          status: "succeeded",
          recordsRead: read,
          recordsWritten: written,
        });
        if (deps.profileCacheDelete) {
          const ids = new Set(
            result.messages
              .map((m) => m.user.twitchUserId)
              .filter((id): id is string => Boolean(id)),
          );
          if (userRef.kind === "id") ids.add(userRef.twitchUserId);
          for (const id of ids) await deps.profileCacheDelete(`profile:${id}`);
        }
      } catch (error) {
        await finishSyncRun(pool, runId, {
          status: "failed",
          recordsRead: read,
          recordsWritten: written,
          error: (error as Error).message,
        });
        return reply.status(502).send(apiError("PROVIDER_SYNC_FAILED", (error as Error).message));
      }

      await recordAuditEvent(pool, {
        organizationId: record.organizationId,
        actorUserId: request.session!.appUserId,
        action: "provider.sync",
        targetType: "provider",
        targetId: record.id,
        metadata: { read, written },
      });
      return reply.send({ ok: true, read, written });
    },
  );

  app.delete<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "No database."));
      const orgs = await requireAdminOrgs(request.session!.appUserId);
      const deleted = await deleteProvider(pool, request.params.providerId, orgs.admin);
      if (!deleted) {
        return reply
          .status(404)
          .send(apiError("NOT_FOUND", "Provider not found in your admin organizations."));
      }
      await recordAuditEvent(pool, {
        organizationId: null,
        actorUserId: request.session!.appUserId,
        action: "provider.delete",
        targetType: "provider",
        targetId: request.params.providerId,
      });
      return reply.send({ ok: true });
    },
  );
}
