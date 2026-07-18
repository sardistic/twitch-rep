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
