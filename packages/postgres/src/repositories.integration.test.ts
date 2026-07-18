import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type PostgresPool } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  createOrganizationWithOwner,
  getAppUserById,
  getMembershipRole,
  getMembershipsForUser,
  getTwitchUserByLogin,
  saveOauthGrant,
  upsertAppUser,
  upsertTwitchUser,
} from "./repositories.js";

const baseUrl = process.env.POSTGRES_URL;

describe.skipIf(!baseUrl)("postgres repositories (integration)", () => {
  const testDb = `chatterscope_test_${Date.now()}`;
  let admin: PostgresPool;
  let pool: PostgresPool;

  beforeAll(async () => {
    admin = createPool(baseUrl!);
    await admin.query(`CREATE DATABASE ${testDb}`);
    const url = new URL(baseUrl!);
    url.pathname = `/${testDb}`;
    pool = createPool(url.toString());
    const here = path.dirname(fileURLToPath(import.meta.url));
    await runMigrations(pool, path.resolve(here, "../migrations"));
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${testDb} (FORCE)`);
    await admin.end();
  });

  it("upserts and reads app users", async () => {
    const created = await upsertAppUser(pool, {
      twitchUserId: "900100001",
      login: "test_mod",
      displayName: "TestMod",
      profileImageUrl: null,
    });
    const updated = await upsertAppUser(pool, {
      twitchUserId: "900100001",
      login: "test_mod_renamed",
      displayName: "TestModRenamed",
      profileImageUrl: null,
    });
    expect(updated.id).toBe(created.id);
    expect((await getAppUserById(pool, created.id))?.login).toBe("test_mod_renamed");
  });

  it("caches Twitch users and finds them by login", async () => {
    await upsertTwitchUser(pool, {
      twitchUserId: "900100002",
      login: "cached_user",
      displayName: "CachedUser",
      accountCreatedAt: new Date("2020-01-01T00:00:00Z"),
      profileImageUrl: null,
      broadcasterType: null,
      description: null,
    });
    const byLogin = await getTwitchUserByLogin(pool, "cached_user");
    expect(byLogin?.twitchUserId).toBe("900100002");
  });

  it("enforces organization boundaries via membership role lookups", async () => {
    const owner = await upsertAppUser(pool, {
      twitchUserId: "900100003",
      login: "org_owner",
      displayName: "OrgOwner",
      profileImageUrl: null,
    });
    const outsider = await upsertAppUser(pool, {
      twitchUserId: "900100004",
      login: "outsider",
      displayName: "Outsider",
      profileImageUrl: null,
    });
    const org = await createOrganizationWithOwner(pool, "Owner Org", owner.id);

    expect(await getMembershipRole(pool, org.id, owner.id)).toBe("owner");
    expect(await getMembershipRole(pool, org.id, outsider.id)).toBeNull();

    const memberships = await getMembershipsForUser(pool, owner.id);
    expect(memberships).toEqual([
      { organizationId: org.id, organizationName: "Owner Org", role: "owner" },
    ]);
    expect(await getMembershipsForUser(pool, outsider.id)).toEqual([]);
  });

  it("keeps moderation notes private to their organization", async () => {
    const { createNote, listNotes, softDeleteNote, updateNote } = await import("./notes.js");
    const alice = await upsertAppUser(pool, {
      twitchUserId: "900100010",
      login: "alice_mod",
      displayName: "AliceMod",
      profileImageUrl: null,
    });
    const bob = await upsertAppUser(pool, {
      twitchUserId: "900100011",
      login: "bob_mod",
      displayName: "BobMod",
      profileImageUrl: null,
    });
    const orgA = await createOrganizationWithOwner(pool, "Org A", alice.id);
    const orgB = await createOrganizationWithOwner(pool, "Org B", bob.id);
    await upsertTwitchUser(pool, {
      twitchUserId: "900100012",
      login: "subject_user",
      displayName: "SubjectUser",
      accountCreatedAt: null,
      profileImageUrl: null,
      broadcasterType: null,
      description: null,
    });

    const note = await createNote(pool, {
      organizationId: orgA.id,
      twitchUserId: "900100012",
      twitchChannelId: null,
      authorUserId: alice.id,
      body: "org A private note",
    });

    expect(await listNotes(pool, [orgA.id], "900100012")).toHaveLength(1);
    // Bob's org cannot see org A's note.
    expect(await listNotes(pool, [orgB.id], "900100012")).toHaveLength(0);
    // Only the author can edit or delete.
    expect(await updateNote(pool, note.id, bob.id, "hijacked")).toBeNull();
    expect(await softDeleteNote(pool, note.id, bob.id)).toBe(false);
    expect((await updateNote(pool, note.id, alice.id, "edited"))?.body).toBe("edited");
    expect(await softDeleteNote(pool, note.id, alice.id)).toBe(true);
    expect(await listNotes(pool, [orgA.id], "900100012")).toHaveLength(0);
  });

  it("stores oauth grants as ciphertext only", async () => {
    const owner = await upsertAppUser(pool, {
      twitchUserId: "900100005",
      login: "grant_user",
      displayName: "GrantUser",
      profileImageUrl: null,
    });
    const org = await createOrganizationWithOwner(pool, "Grant Org", owner.id);
    await saveOauthGrant(pool, {
      organizationId: org.id,
      twitchUserId: "900100005",
      accessTokenCiphertext: Buffer.from("sealed-access"),
      refreshTokenCiphertext: Buffer.from("sealed-refresh"),
      scopes: ["user:read:email"],
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const stored = await pool.query<{ access_token_ciphertext: Buffer }>(
      "SELECT access_token_ciphertext FROM oauth_grants WHERE twitch_user_id = $1",
      ["900100005"],
    );
    expect(Buffer.isBuffer(stored.rows[0]!.access_token_ciphertext)).toBe(true);
  });
});
