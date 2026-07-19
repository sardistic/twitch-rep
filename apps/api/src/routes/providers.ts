import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiError } from "@chatterscope/contracts";
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
  getTwitchUserById,
  getTwitchUserByLogin,
  listOrganizationChannels,
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

  /** Queries one provider for one user in one channel and ingests the results. */
  async function importFromProvider(
    record: ProviderRecord,
    provider: ChatLogProvider,
    userRef: { twitchUserId?: string; login?: string },
    channelRef: { twitchChannelId?: string; login?: string },
    limit: number,
  ): Promise<{ read: number; written: number }> {
    const result = await provider.queryMessages({
      user: userRef,
      channel: channelRef,
      limit,
    });
    let written = 0;
    for (const message of result.messages) {
      const userId =
        message.user.twitchUserId ??
        userRef.twitchUserId ??
        (message.user.login
          ? (await getTwitchUserByLogin(pool!, message.user.login))?.twitchUserId
          : undefined);
      const channelId =
        message.channel.twitchChannelId ??
        channelRef.twitchChannelId ??
        (message.channel.login
          ? (await getTwitchUserByLogin(pool!, message.channel.login))?.twitchUserId
          : undefined);
      if (!userId || !channelId) continue;
      const outcome = await ingestor!.ingest({
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
      });
      if (outcome.status === "ingested") written += 1;
    }
    return { read: result.messages.length, written };
  }

  type EnrichProgress = {
    status: "running" | "done" | "failed";
    scanned: number;
    total: number;
    channelsWithLogs: number;
    read: number;
    written: number;
    startedAt: string;
    error?: string;
    lastError?: string;
    failedQueries?: number;
  };

  const ENRICH_TTL_SECONDS = 60 * 60;
  // Serial with spacing: public log instances rate-limit per IP aggressively.
  const ENRICH_CONCURRENCY = 1;
  const ENRICH_SPACING_MS = 350;
  // Catalogs larger than this (e.g. 287k-channel aggregators) cannot be
  // brute-scanned politely; fall back to targeted channels instead.
  const ENRICH_FULL_SCAN_MAX = 5000;
  const runningEnrich = new Set<string>();

  async function runEnrich(twitchUserId: string, actorUserId: string, orgId: string | null) {
    const key = `enrich:${twitchUserId}`;
    const progress: EnrichProgress = {
      status: "running",
      scanned: 0,
      total: 0,
      channelsWithLogs: 0,
      read: 0,
      written: 0,
      startedAt: new Date().toISOString(),
    };
    const save = () => deps.kv?.set(key, JSON.stringify(progress), ENRICH_TTL_SECONDS);
    await save();
    try {
      const providers = (await listProvidersForOrgs(pool!, orgId ? [orgId] : [])).filter(
        (p) => p.enabled,
      );
      const cachedUser = await getTwitchUserById(pool!, twitchUserId);
      const userRef = {
        twitchUserId,
        ...(cachedUser ? { login: cachedUser.login } : {}),
      };
      // Channels we already know this user appears in (from prior native or
      // provider evidence) plus the org's watched channels — the targeted set
      // used for providers whose catalog is too large to scan fully.
      const targeted = new Map<string, { twitchChannelId?: string; login?: string }>();
      for (const c of orgId ? await listOrganizationChannels(pool!, orgId) : []) {
        targeted.set(c.twitchChannelId, { twitchChannelId: c.twitchChannelId, login: c.login });
      }
      if (deps.profiles) {
        try {
          const known = await deps.profiles.getProfile(twitchUserId);
          for (const role of known.roles) {
            targeted.set(role.channel.twitchChannelId, {
              twitchChannelId: role.channel.twitchChannelId,
              ...(role.channel.login ? { login: role.channel.login } : {}),
            });
          }
        } catch {
          // profile unavailable — targeted set stays org-only
        }
      }

      for (const record of providers) {
        const provider = buildProvider(record);
        // Scan the provider's full catalog when it is small enough to walk
        // politely; otherwise query only targeted channels.
        let channels: Array<{ twitchChannelId?: string; login?: string }>;
        try {
          const catalog = provider.listChannels ? await provider.listChannels() : null;
          channels =
            catalog && catalog.length <= ENRICH_FULL_SCAN_MAX ? catalog : [...targeted.values()];
        } catch {
          channels = [...targeted.values()];
        }
        progress.total += channels.length;
        await save();
        const runId = await startSyncRun(pool!, record.id);
        let queue = [...channels];
        let failed = 0;
        const worker = async () => {
          for (;;) {
            const channel = queue.shift();
            if (!channel) return;
            try {
              // Role status only needs a handful of recent lines per channel.
              const outcome = await importFromProvider(record, provider, userRef, channel, 20);
              progress.read += outcome.read;
              progress.written += outcome.written;
              if (outcome.read > 0) progress.channelsWithLogs += 1;
            } catch (error) {
              const message = (error as Error).message;
              progress.lastError = message;
              app.log.warn(
                { provider: record.name, channel: channel.login ?? channel.twitchChannelId, err: message },
                "enrich channel query failed",
              );
              // Rate limits are pacing feedback, not provider failure — the
              // adapter already waited; only hard errors count toward abandon.
              if (!message.includes("429")) {
                failed += 1;
                progress.failedQueries = failed;
                if (failed > 20) queue = [];
              }
            }
            progress.scanned += 1;
            if (progress.scanned % 25 === 0) await save();
            await new Promise((r) => setTimeout(r, ENRICH_SPACING_MS));
          }
        };
        await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, () => worker()));
        await finishSyncRun(pool!, runId, {
          status: failed > 20 ? "failed" : "succeeded",
          recordsRead: progress.read,
          recordsWritten: progress.written,
          ...(failed > 0 ? { error: `${failed} channel queries failed` } : {}),
        });
      }
      progress.status = "done";
    } catch (error) {
      progress.status = "failed";
      progress.error = (error as Error).message;
    }
    await save();
    await deps.profileCacheDelete?.(`profile:${twitchUserId}`);
    await recordAuditEvent(pool!, {
      organizationId: orgId,
      actorUserId,
      action: "chatter.enrich",
      targetType: "twitch_user",
      targetId: twitchUserId,
      metadata: { read: progress.read, written: progress.written, scanned: progress.scanned },
    });
    runningEnrich.delete(twitchUserId);
  }

  /**
   * Fetches this user's history from every enabled provider across every
   * channel each provider has logs for. Runs in the background; poll the
   * status endpoint for progress.
   */
  app.post<{ Params: { twitchUserId: string } }>(
    "/v1/chatters/:twitchUserId/enrich",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool || !ingestor || !deps.kv) {
        return reply.status(503).send(apiError("NOT_CONFIGURED", "Ingestion unavailable."));
      }
      const { twitchUserId } = request.params;
      if (!/^\d{1,20}$/.test(twitchUserId)) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Twitch user IDs are numeric."));
      }
      const orgs = await requireAdminOrgs(request.session!.appUserId);
      if (orgs.admin.length === 0) {
        return reply.status(403).send(apiError("FORBIDDEN", "Admin access required."));
      }
      const providers = (await listProvidersForOrgs(pool, orgs.admin)).filter((p) => p.enabled);
      if (providers.length === 0) {
        return reply
          .status(400)
          .send(apiError("NO_PROVIDERS", "Configure a log provider first (Providers tab)."));
      }
      if (runningEnrich.has(twitchUserId)) {
        return reply.status(202).send({ started: false, alreadyRunning: true });
      }
      runningEnrich.add(twitchUserId);
      void runEnrich(twitchUserId, request.session!.appUserId, orgs.admin[0] ?? null).catch(
        (error) => request.log.error({ err: error }, "enrich job crashed"),
      );
      return reply.status(202).send({ started: true });
    },
  );

  app.get<{ Params: { twitchUserId: string } }>(
    "/v1/chatters/:twitchUserId/enrich/status",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!deps.kv) return reply.status(503).send(apiError("NOT_CONFIGURED", "Unavailable."));
      const raw = await deps.kv.get(`enrich:${request.params.twitchUserId}`);
      if (!raw) return reply.status(404).send(apiError("NOT_FOUND", "No enrichment job found."));
      return reply.send(JSON.parse(raw));
    },
  );

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
        const outcome = await importFromProvider(
          record,
          provider,
          userRef.kind === "id" ? { twitchUserId: userRef.twitchUserId } : { login: userRef.login },
          channelRef.kind === "id"
            ? { twitchChannelId: channelRef.twitchUserId }
            : { login: channelRef.login },
          parsed.data.limit ?? 500,
        );
        read = outcome.read;
        written = outcome.written;
        await finishSyncRun(pool, runId, {
          status: "succeeded",
          recordsRead: read,
          recordsWritten: written,
        });
        if (userRef.kind === "id") {
          await deps.profileCacheDelete?.(`profile:${userRef.twitchUserId}`);
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
