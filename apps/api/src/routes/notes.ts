import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiError } from "@chatterscope/contracts";
import {
  createNote,
  getMembershipsForUser,
  getTwitchUserById,
  listAuditEvents,
  listNotes,
  recordAuditEvent,
  softDeleteNote,
  updateNote,
} from "@chatterscope/postgres";
import { requireSession } from "../plugins/auth-guard.js";
import type { ServerDeps } from "../server.js";

const ID_PATTERN = /^\d{1,20}$/;
const noteBodySchema = z.object({
  body: z.string().min(1).max(10_000),
  organizationId: z.string().uuid().optional(),
  twitchChannelId: z.string().regex(ID_PATTERN).nullish(),
});
const noteEditSchema = z.object({ body: z.string().min(1).max(10_000) });

function serializeNote(note: {
  id: string;
  organizationId: string;
  twitchChannelId: string | null;
  authorUserId: string;
  authorLogin: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: note.id,
    organizationId: note.organizationId,
    twitchChannelId: note.twitchChannelId,
    authorUserId: note.authorUserId,
    authorLogin: note.authorLogin,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

export function registerNoteRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { pool } = deps;

  app.get<{ Params: { twitchUserId: string } }>(
    "/v1/chatters/:twitchUserId/notes",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) {
        return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
      }
      if (!ID_PATTERN.test(request.params.twitchUserId)) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Twitch user IDs are numeric."));
      }
      const memberships = await getMembershipsForUser(pool, request.session!.appUserId);
      const notes = await listNotes(
        pool,
        memberships.map((m) => m.organizationId),
        request.params.twitchUserId,
      );
      return reply.send({ notes: notes.map(serializeNote) });
    },
  );

  app.post<{ Params: { twitchUserId: string } }>(
    "/v1/chatters/:twitchUserId/notes",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) {
        return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
      }
      if (!ID_PATTERN.test(request.params.twitchUserId)) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Twitch user IDs are numeric."));
      }
      const parsed = noteBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send(apiError("INVALID_INPUT", "Note body is required (max 10k)."));
      }
      const memberships = await getMembershipsForUser(pool, request.session!.appUserId);
      const organizationId = parsed.data.organizationId ?? memberships[0]?.organizationId;
      if (!organizationId || !memberships.some((m) => m.organizationId === organizationId)) {
        return reply
          .status(403)
          .send(apiError("FORBIDDEN", "You are not a member of that organization."));
      }
      if (!(await getTwitchUserById(pool, request.params.twitchUserId))) {
        return reply
          .status(404)
          .send(apiError("USER_NOT_FOUND", "Resolve the Twitch user before adding notes."));
      }
      const note = await createNote(pool, {
        organizationId,
        twitchUserId: request.params.twitchUserId,
        twitchChannelId: parsed.data.twitchChannelId ?? null,
        authorUserId: request.session!.appUserId,
        body: parsed.data.body,
      });
      await recordAuditEvent(pool, {
        organizationId,
        actorUserId: request.session!.appUserId,
        action: "note.create",
        targetType: "moderation_note",
        targetId: note.id,
        metadata: { twitchUserId: request.params.twitchUserId },
      });
      return reply.status(201).send({ note: serializeNote(note) });
    },
  );

  app.patch<{ Params: { twitchUserId: string; noteId: string } }>(
    "/v1/chatters/:twitchUserId/notes/:noteId",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) {
        return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
      }
      const parsed = noteEditSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send(apiError("INVALID_INPUT", "Note body is required."));
      }
      const note = await updateNote(
        pool,
        request.params.noteId,
        request.session!.appUserId,
        parsed.data.body,
      );
      if (!note) {
        return reply
          .status(404)
          .send(apiError("NOTE_NOT_FOUND", "Note does not exist or you are not its author."));
      }
      await recordAuditEvent(pool, {
        organizationId: note.organizationId,
        actorUserId: request.session!.appUserId,
        action: "note.update",
        targetType: "moderation_note",
        targetId: note.id,
      });
      return reply.send({ note: serializeNote(note) });
    },
  );

  app.delete<{ Params: { twitchUserId: string; noteId: string } }>(
    "/v1/chatters/:twitchUserId/notes/:noteId",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) {
        return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
      }
      const deleted = await softDeleteNote(pool, request.params.noteId, request.session!.appUserId);
      if (!deleted) {
        return reply
          .status(404)
          .send(apiError("NOTE_NOT_FOUND", "Note does not exist or you are not its author."));
      }
      await recordAuditEvent(pool, {
        organizationId: null,
        actorUserId: request.session!.appUserId,
        action: "note.delete",
        targetType: "moderation_note",
        targetId: request.params.noteId,
      });
      return reply.send({ ok: true });
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/v1/audit",
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      if (!pool) {
        return reply.status(503).send(apiError("DATABASE_UNAVAILABLE", "Database not configured."));
      }
      const memberships = await getMembershipsForUser(pool, request.session!.appUserId);
      const events = await listAuditEvents(pool, {
        organizationIds: memberships.map((m) => m.organizationId),
        actorUserId: request.session!.appUserId,
        limit: Number(request.query.limit ?? 50) || 50,
      });
      return reply.send({
        events: events.map((event) => ({
          id: event.id,
          actorLogin: event.actorLogin,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          createdAt: event.createdAt.toISOString(),
        })),
      });
    },
  );
}
