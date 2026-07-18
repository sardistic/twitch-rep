import type { PostgresPool } from "./client.js";

/**
 * Deterministic development seed data. All Twitch IDs use a 900xxxxxx range
 * and *_demo logins so no real Twitch account can collide with them.
 * Fixed UUIDs make the seed idempotent (every insert is ON CONFLICT DO NOTHING).
 */
const ORG_ALPHA = "11111111-1111-4111-8111-111111111111";
const ORG_BETA = "22222222-2222-4222-8222-222222222222";
const APP_USER_MOD_ALPHA = "33333333-3333-4333-8333-333333333333";
const APP_USER_MOD_BETA = "44444444-4444-4444-8444-444444444444";

type SeedTwitchUser = {
  id: string;
  login: string;
  display: string;
  createdAt: string;
  isChannel: boolean;
};

const twitchUsers: SeedTwitchUser[] = [
  {
    id: "900000001",
    login: "alpha_channel_demo",
    display: "AlphaChannelDemo",
    createdAt: "2016-02-01T00:00:00Z",
    isChannel: true,
  },
  {
    id: "900000002",
    login: "beta_channel_demo",
    display: "BetaChannelDemo",
    createdAt: "2018-06-15T00:00:00Z",
    isChannel: true,
  },
  {
    id: "900000003",
    login: "gamma_channel_demo",
    display: "GammaChannelDemo",
    createdAt: "2019-09-20T00:00:00Z",
    isChannel: true,
  },
  {
    id: "900000004",
    login: "helpful_mod_demo",
    display: "HelpfulModDemo",
    createdAt: "2017-04-12T00:00:00Z",
    isChannel: false,
  },
  {
    id: "900000005",
    login: "casual_viewer_demo",
    display: "CasualViewerDemo",
    createdAt: "2021-01-05T00:00:00Z",
    isChannel: false,
  },
];

export async function seed(pool: PostgresPool, log: (message: string) => void): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO organizations (id, name) VALUES ($1, 'Alpha Moderation Team'), ($2, 'Beta Moderation Team')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ALPHA, ORG_BETA],
    );

    for (const user of twitchUsers) {
      await client.query(
        `INSERT INTO twitch_users (twitch_user_id, login, display_name, account_created_at, fetched_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (twitch_user_id) DO NOTHING`,
        [user.id, user.login, user.display, user.createdAt],
      );
      if (user.isChannel) {
        await client.query(
          `INSERT INTO twitch_channels (twitch_channel_id, login, display_name, fetched_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (twitch_channel_id) DO NOTHING`,
          [user.id, user.login, user.display],
        );
      }
    }

    await client.query(
      `INSERT INTO app_users (id, twitch_user_id, login, display_name)
       VALUES ($1, '900000004', 'helpful_mod_demo', 'HelpfulModDemo'),
              ($2, '900000005', 'casual_viewer_demo', 'CasualViewerDemo')
       ON CONFLICT (id) DO NOTHING`,
      [APP_USER_MOD_ALPHA, APP_USER_MOD_BETA],
    );

    await client.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role)
       VALUES ($1, $3, 'owner'), ($2, $4, 'owner')
       ON CONFLICT DO NOTHING`,
      [ORG_ALPHA, ORG_BETA, APP_USER_MOD_ALPHA, APP_USER_MOD_BETA],
    );

    await client.query(
      `INSERT INTO organization_channels (organization_id, twitch_channel_id, connected_by_user_id)
       VALUES ($1, '900000001', $3), ($1, '900000002', $3), ($2, '900000003', $4)
       ON CONFLICT DO NOTHING`,
      [ORG_ALPHA, ORG_BETA, APP_USER_MOD_ALPHA, APP_USER_MOD_BETA],
    );

    // verified moderator, verified VIP, recent observed moderator badge,
    // historical VIP badge, and one conflicting record
    await client.query(
      `INSERT INTO role_evidence
         (id, twitch_user_id, twitch_channel_id, role_name, status, source,
          first_observed_at, last_observed_at, verified_at, expires_at)
       VALUES
         ('a1111111-1111-4111-8111-111111111111', '900000004', '900000001', 'moderator',
          'verified_current', 'twitch_api',
          '2024-01-05T00:00:00Z', now(), now(), now() + interval '5 minutes'),
         ('a2222222-2222-4222-8222-222222222222', '900000005', '900000001', 'vip',
          'verified_current', 'twitch_api',
          '2025-03-01T00:00:00Z', now(), now(), now() + interval '5 minutes'),
         ('a3333333-3333-4333-8333-333333333333', '900000004', '900000002', 'moderator',
          'observed_recent', 'twitch_irc',
          '2025-11-01T00:00:00Z', now() - interval '2 days', NULL, now() + interval '28 days'),
         ('a4444444-4444-4444-8444-444444444444', '900000005', '900000002', 'vip',
          'observed_historical', 'external_provider',
          '2023-05-01T00:00:00Z', '2024-02-01T00:00:00Z', NULL, NULL),
         ('a5555555-5555-4555-8555-555555555555', '900000004', '900000003', 'vip',
          'conflicting', 'external_provider',
          '2024-08-01T00:00:00Z', now() - interval '10 days', NULL, NULL)
       ON CONFLICT (id) DO NOTHING`,
    );

    await client.query(
      `INSERT INTO moderation_notes (id, organization_id, twitch_user_id, twitch_channel_id, author_user_id, body)
       VALUES
         ('b1111111-1111-4111-8111-111111111111', $1, '900000005', '900000001', $3,
          'Seed note: asked about channel rules on 2026-07-01. Friendly interaction.'),
         ('b2222222-2222-4222-8222-222222222222', $2, '900000004', '900000003', $4,
          'Seed note: helps answer viewer questions. Private to Beta organization.')
       ON CONFLICT (id) DO NOTHING`,
      [ORG_ALPHA, ORG_BETA, APP_USER_MOD_ALPHA, APP_USER_MOD_BETA],
    );

    await client.query("COMMIT");
    log("seed data applied (idempotent)");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
