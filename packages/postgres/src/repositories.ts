import type { PostgresPool } from "./client.js";

export type AppUser = {
  id: string;
  twitchUserId: string;
  login: string;
  displayName: string;
  profileImageUrl: string | null;
};

export type CachedTwitchUser = {
  twitchUserId: string;
  login: string;
  displayName: string;
  accountCreatedAt: Date | null;
  profileImageUrl: string | null;
  broadcasterType: string | null;
  description: string | null;
  fetchedAt: Date;
};

export type MembershipRole = "owner" | "admin" | "moderator" | "viewer";

export type OrganizationMembership = {
  organizationId: string;
  organizationName: string;
  role: MembershipRole;
};

type AppUserRow = {
  id: string;
  twitch_user_id: string;
  login: string;
  display_name: string;
  profile_image_url: string | null;
};

function toAppUser(row: AppUserRow): AppUser {
  return {
    id: row.id,
    twitchUserId: row.twitch_user_id,
    login: row.login,
    displayName: row.display_name,
    profileImageUrl: row.profile_image_url,
  };
}

export async function upsertAppUser(
  pool: PostgresPool,
  user: Omit<AppUser, "id">,
): Promise<AppUser> {
  const result = await pool.query<AppUserRow>(
    `INSERT INTO app_users (twitch_user_id, login, display_name, profile_image_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (twitch_user_id) DO UPDATE SET
       login = EXCLUDED.login,
       display_name = EXCLUDED.display_name,
       profile_image_url = EXCLUDED.profile_image_url,
       updated_at = now()
     RETURNING id, twitch_user_id, login, display_name, profile_image_url`,
    [user.twitchUserId, user.login, user.displayName, user.profileImageUrl],
  );
  return toAppUser(result.rows[0]!);
}

export async function getAppUserById(pool: PostgresPool, id: string): Promise<AppUser | null> {
  const result = await pool.query<AppUserRow>(
    `SELECT id, twitch_user_id, login, display_name, profile_image_url
     FROM app_users WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? toAppUser(result.rows[0]) : null;
}

type TwitchUserRow = {
  twitch_user_id: string;
  login: string;
  display_name: string;
  account_created_at: Date | null;
  profile_image_url: string | null;
  broadcaster_type: string | null;
  description: string | null;
  fetched_at: Date;
};

function toCachedTwitchUser(row: TwitchUserRow): CachedTwitchUser {
  return {
    twitchUserId: row.twitch_user_id,
    login: row.login,
    displayName: row.display_name,
    accountCreatedAt: row.account_created_at,
    profileImageUrl: row.profile_image_url,
    broadcasterType: row.broadcaster_type,
    description: row.description,
    fetchedAt: row.fetched_at,
  };
}

export async function upsertTwitchUser(
  pool: PostgresPool,
  user: Omit<CachedTwitchUser, "fetchedAt">,
): Promise<CachedTwitchUser> {
  const result = await pool.query<TwitchUserRow>(
    `INSERT INTO twitch_users
       (twitch_user_id, login, display_name, account_created_at, profile_image_url,
        broadcaster_type, description, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (twitch_user_id) DO UPDATE SET
       login = EXCLUDED.login,
       display_name = EXCLUDED.display_name,
       account_created_at = EXCLUDED.account_created_at,
       profile_image_url = EXCLUDED.profile_image_url,
       broadcaster_type = EXCLUDED.broadcaster_type,
       description = EXCLUDED.description,
       fetched_at = now(),
       updated_at = now()
     RETURNING twitch_user_id, login, display_name, account_created_at, profile_image_url,
               broadcaster_type, description, fetched_at`,
    [
      user.twitchUserId,
      user.login,
      user.displayName,
      user.accountCreatedAt,
      user.profileImageUrl,
      user.broadcasterType,
      user.description,
    ],
  );
  return toCachedTwitchUser(result.rows[0]!);
}

export async function getTwitchUserById(
  pool: PostgresPool,
  twitchUserId: string,
): Promise<CachedTwitchUser | null> {
  const result = await pool.query<TwitchUserRow>(
    `SELECT twitch_user_id, login, display_name, account_created_at, profile_image_url,
            broadcaster_type, description, fetched_at
     FROM twitch_users WHERE twitch_user_id = $1`,
    [twitchUserId],
  );
  return result.rows[0] ? toCachedTwitchUser(result.rows[0]) : null;
}

export async function getTwitchUserByLogin(
  pool: PostgresPool,
  login: string,
): Promise<CachedTwitchUser | null> {
  const result = await pool.query<TwitchUserRow>(
    `SELECT twitch_user_id, login, display_name, account_created_at, profile_image_url,
            broadcaster_type, description, fetched_at
     FROM twitch_users WHERE login = $1
     ORDER BY fetched_at DESC LIMIT 1`,
    [login],
  );
  return result.rows[0] ? toCachedTwitchUser(result.rows[0]) : null;
}

/** Creates a personal organization for a first-time user, owned by them. */
export async function createOrganizationWithOwner(
  pool: PostgresPool,
  name: string,
  ownerUserId: string,
): Promise<{ id: string; name: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const org = await client.query<{ id: string; name: string }>(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id, name",
      [name],
    );
    await client.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [org.rows[0]!.id, ownerUserId],
    );
    await client.query("COMMIT");
    return org.rows[0]!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getMembershipsForUser(
  pool: PostgresPool,
  userId: string,
): Promise<OrganizationMembership[]> {
  const result = await pool.query<{
    organization_id: string;
    organization_name: string;
    role: MembershipRole;
  }>(
    `SELECT m.organization_id, o.name AS organization_name, m.role
     FROM organization_memberships m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = $1
     ORDER BY o.name`,
    [userId],
  );
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    role: row.role,
  }));
}

/** Returns the member's role, or null when they are not in the organization. */
export async function getMembershipRole(
  pool: PostgresPool,
  organizationId: string,
  userId: string,
): Promise<MembershipRole | null> {
  const result = await pool.query<{ role: MembershipRole }>(
    `SELECT role FROM organization_memberships
     WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  return result.rows[0]?.role ?? null;
}

export async function saveOauthGrant(
  pool: PostgresPool,
  grant: {
    organizationId: string;
    twitchUserId: string;
    accessTokenCiphertext: Buffer;
    refreshTokenCiphertext: Buffer;
    scopes: string[];
    expiresAt: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_grants
       (organization_id, twitch_user_id, access_token_ciphertext,
        refresh_token_ciphertext, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, twitch_user_id) DO UPDATE SET
       access_token_ciphertext = EXCLUDED.access_token_ciphertext,
       refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
       scopes = EXCLUDED.scopes,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      grant.organizationId,
      grant.twitchUserId,
      grant.accessTokenCiphertext,
      grant.refreshTokenCiphertext,
      grant.scopes,
      grant.expiresAt,
    ],
  );
}

export async function upsertTwitchChannel(
  pool: PostgresPool,
  channel: { twitchChannelId: string; login: string; displayName: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO twitch_channels (twitch_channel_id, login, display_name, fetched_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (twitch_channel_id) DO UPDATE SET
       login = EXCLUDED.login,
       display_name = EXCLUDED.display_name,
       fetched_at = now(),
       updated_at = now()`,
    [channel.twitchChannelId, channel.login, channel.displayName],
  );
}

export async function connectOrganizationChannel(
  pool: PostgresPool,
  organizationId: string,
  twitchChannelId: string,
  connectedByUserId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO organization_channels (organization_id, twitch_channel_id, connected_by_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, twitch_channel_id) DO UPDATE SET enabled = true`,
    [organizationId, twitchChannelId, connectedByUserId],
  );
}

export type OrganizationChannel = {
  twitchChannelId: string;
  login: string;
  displayName: string;
  enabled: boolean;
  connectedAt: Date;
};

export async function listOrganizationChannels(
  pool: PostgresPool,
  organizationId: string,
): Promise<OrganizationChannel[]> {
  const result = await pool.query<{
    twitch_channel_id: string;
    login: string;
    display_name: string;
    enabled: boolean;
    connected_at: Date;
  }>(
    `SELECT c.twitch_channel_id, c.login, c.display_name, oc.enabled, oc.connected_at
     FROM organization_channels oc
     JOIN twitch_channels c ON c.twitch_channel_id = oc.twitch_channel_id
     WHERE oc.organization_id = $1
     ORDER BY c.login`,
    [organizationId],
  );
  return result.rows.map((row) => ({
    twitchChannelId: row.twitch_channel_id,
    login: row.login,
    displayName: row.display_name,
    enabled: row.enabled,
    connectedAt: row.connected_at,
  }));
}

/**
 * Light identity upsert from chat observations: refreshes login/display name
 * without clobbering richer fields fetched from the Twitch API.
 */
export async function upsertTwitchUserIdentity(
  pool: PostgresPool,
  identity: { twitchUserId: string; login: string; displayName: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO twitch_users (twitch_user_id, login, display_name, fetched_at)
     VALUES ($1, $2, $3, to_timestamp(0))
     ON CONFLICT (twitch_user_id) DO UPDATE SET
       login = EXCLUDED.login,
       display_name = EXCLUDED.display_name,
       updated_at = now()`,
    [identity.twitchUserId, identity.login, identity.displayName],
  );
}

/** Logins of every enabled channel across all organizations (ingest watch list). */
export async function listAllEnabledChannelLogins(pool: PostgresPool): Promise<string[]> {
  const result = await pool.query<{ login: string }>(
    `SELECT DISTINCT c.login
     FROM organization_channels oc
     JOIN twitch_channels c ON c.twitch_channel_id = oc.twitch_channel_id
     WHERE oc.enabled = true`,
  );
  return result.rows.map((row) => row.login);
}

export async function setOrganizationChannelEnabled(
  pool: PostgresPool,
  organizationIds: string[],
  twitchChannelId: string,
  enabled: boolean,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE organization_channels SET enabled = $3
     WHERE organization_id = ANY($1) AND twitch_channel_id = $2`,
    [organizationIds, twitchChannelId, enabled],
  );
  return (result.rowCount ?? 0) > 0;
}

export type VerifiedAssertionRow = {
  twitchChannelId: string;
  roleName: string;
  source: "twitch_api" | "twitch_eventsub" | "manual";
  verifiedAt: Date;
  endedAt: Date | null;
};

/**
 * Verified role assertions for a user (Twitch API / EventSub / manual only —
 * badge observations never appear here). endedAt null = still current.
 */
export async function getVerifiedAssertionsForUser(
  pool: PostgresPool,
  twitchUserId: string,
): Promise<VerifiedAssertionRow[]> {
  const result = await pool.query<{
    twitch_channel_id: string;
    role_name: string;
    source: "twitch_api" | "twitch_eventsub" | "manual";
    verified_at: Date;
    status: string;
    expires_at: Date | null;
  }>(
    `SELECT twitch_channel_id, role_name, source, verified_at, status, expires_at
     FROM role_evidence
     WHERE twitch_user_id = $1
       AND source IN ('twitch_api', 'twitch_eventsub', 'manual')
       AND verified_at IS NOT NULL`,
    [twitchUserId],
  );
  return result.rows.map((row) => ({
    twitchChannelId: row.twitch_channel_id,
    roleName: row.role_name,
    source: row.source,
    verifiedAt: row.verified_at,
    endedAt: row.status === "verified_current" ? null : row.expires_at,
  }));
}

export type ChannelMeta = { twitchChannelId: string; login: string; displayName: string };

export async function getChannelMeta(
  pool: PostgresPool,
  twitchChannelIds: string[],
): Promise<Map<string, ChannelMeta>> {
  if (twitchChannelIds.length === 0) return new Map();
  const result = await pool.query<{
    twitch_channel_id: string;
    login: string;
    display_name: string;
  }>(
    `SELECT twitch_channel_id, login, display_name
     FROM twitch_channels WHERE twitch_channel_id = ANY($1)`,
    [twitchChannelIds],
  );
  return new Map(
    result.rows.map((row) => [
      row.twitch_channel_id,
      { twitchChannelId: row.twitch_channel_id, login: row.login, displayName: row.display_name },
    ]),
  );
}

export async function recordAuditEvent(
  pool: PostgresPool,
  event: {
    organizationId: string | null;
    actorUserId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.organizationId,
      event.actorUserId,
      event.action,
      event.targetType,
      event.targetId,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
