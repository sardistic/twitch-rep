import type { PostgresPool } from "./client.js";

export type ModerationNote = {
  id: string;
  organizationId: string;
  twitchUserId: string;
  twitchChannelId: string | null;
  authorUserId: string;
  authorLogin: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
};

type NoteRow = {
  id: string;
  organization_id: string;
  twitch_user_id: string;
  twitch_channel_id: string | null;
  author_user_id: string;
  author_login: string;
  body: string;
  created_at: Date;
  updated_at: Date;
};

function toNote(row: NoteRow): ModerationNote {
  return {
    id: row.id,
    organizationId: row.organization_id,
    twitchUserId: row.twitch_user_id,
    twitchChannelId: row.twitch_channel_id,
    authorUserId: row.author_user_id,
    authorLogin: row.author_login,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const NOTE_COLUMNS = `n.id, n.organization_id, n.twitch_user_id, n.twitch_channel_id,
  n.author_user_id, a.login AS author_login, n.body, n.created_at, n.updated_at`;

/** Notes are org-private: only notes belonging to the caller's orgs return. */
export async function listNotes(
  pool: PostgresPool,
  organizationIds: string[],
  twitchUserId: string,
): Promise<ModerationNote[]> {
  if (organizationIds.length === 0) return [];
  const result = await pool.query<NoteRow>(
    `SELECT ${NOTE_COLUMNS}
     FROM moderation_notes n
     JOIN app_users a ON a.id = n.author_user_id
     WHERE n.twitch_user_id = $1
       AND n.organization_id = ANY($2)
       AND n.deleted_at IS NULL
     ORDER BY n.created_at DESC`,
    [twitchUserId, organizationIds],
  );
  return result.rows.map(toNote);
}

export async function createNote(
  pool: PostgresPool,
  note: {
    organizationId: string;
    twitchUserId: string;
    twitchChannelId: string | null;
    authorUserId: string;
    body: string;
  },
): Promise<ModerationNote> {
  const result = await pool.query<NoteRow>(
    `WITH inserted AS (
       INSERT INTO moderation_notes (organization_id, twitch_user_id, twitch_channel_id, author_user_id, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *
     )
     SELECT ${NOTE_COLUMNS}
     FROM inserted n JOIN app_users a ON a.id = n.author_user_id`,
    [note.organizationId, note.twitchUserId, note.twitchChannelId, note.authorUserId, note.body],
  );
  return toNote(result.rows[0]!);
}

/** Only the author may edit their note. Returns null when not found/not author. */
export async function updateNote(
  pool: PostgresPool,
  noteId: string,
  authorUserId: string,
  body: string,
): Promise<ModerationNote | null> {
  const result = await pool.query<NoteRow>(
    `WITH updated AS (
       UPDATE moderation_notes
       SET body = $3, updated_at = now()
       WHERE id = $1 AND author_user_id = $2 AND deleted_at IS NULL
       RETURNING *
     )
     SELECT ${NOTE_COLUMNS}
     FROM updated n JOIN app_users a ON a.id = n.author_user_id`,
    [noteId, authorUserId, body],
  );
  return result.rows[0] ? toNote(result.rows[0]) : null;
}

/** Soft delete by the author. Returns true when a row was affected. */
export async function softDeleteNote(
  pool: PostgresPool,
  noteId: string,
  authorUserId: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE moderation_notes SET deleted_at = now()
     WHERE id = $1 AND author_user_id = $2 AND deleted_at IS NULL`,
    [noteId, authorUserId],
  );
  return (result.rowCount ?? 0) > 0;
}

export type AuditEventRow = {
  id: string;
  organizationId: string | null;
  actorLogin: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export async function listAuditEvents(
  pool: PostgresPool,
  options: { organizationIds: string[]; actorUserId?: string; limit: number },
): Promise<AuditEventRow[]> {
  const limit = Math.min(Math.max(options.limit, 1), 200);
  const result = await pool.query<{
    id: string;
    organization_id: string | null;
    actor_login: string | null;
    action: string;
    target_type: string;
    target_id: string | null;
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT e.id, e.organization_id, a.login AS actor_login, e.action,
            e.target_type, e.target_id, e.metadata, e.created_at
     FROM audit_events e
     LEFT JOIN app_users a ON a.id = e.actor_user_id
     WHERE e.organization_id = ANY($1)
        OR ($2::uuid IS NOT NULL AND e.actor_user_id = $2)
     ORDER BY e.created_at DESC
     LIMIT $3`,
    [options.organizationIds, options.actorUserId ?? null, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    actorLogin: row.actor_login,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}
