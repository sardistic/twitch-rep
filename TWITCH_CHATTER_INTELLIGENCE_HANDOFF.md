# Twitch Chatter Intelligence — VS Code Engineering Handoff

## Project Goal

Build a moderation research tool that lets an authorized Twitch moderator or broadcaster enter or click a Twitch username and immediately see a consolidated, evidence-based profile containing:

- Twitch account identity and account age
- The user’s relationship to the current channel
- Current moderator or VIP roles confirmed by participating channels
- Moderator, VIP, subscriber, founder, staff, and similar badges observed in indexed chat messages
- Channels where the user has been observed
- First and most recent observation timestamps
- Message counts and recent message excerpts
- Local moderation notes and actions
- Data source, freshness, and confidence for every assertion

The application must never imply that it has complete knowledge of Twitch. It must clearly distinguish verified Twitch API results from historical observations and external-provider data.

Working name: `ChatterScope`

## Product Position

This is a moderation context tool, not a reputation scoring system.

Do not create a single trust score, danger score, toxicity score, or automated recommendation to ban a user. Moderators should see evidence and make the decision themselves.

Do not collect or expose off-platform personal information. Do not attempt to correlate Twitch users with legal names, addresses, social accounts, leaked credentials, or other identities.

## User Experience

### Primary flow

1. Moderator signs in with Twitch.
2. Moderator searches for a Twitch login or numeric user ID.
3. The backend resolves the canonical Twitch user ID.
4. The profile page displays:
   - Canonical identity
   - Account creation date
   - Current-channel context
   - Verified roles
   - Observed roles
   - Channel activity
   - Recent messages
   - Local moderation history
   - Data freshness
5. The moderator can filter results by channel, role, source, and date range.
6. A later browser extension can open the same profile from a Twitch chatter card.

### Evidence labels

Every displayed relationship must have one of these statuses:

| Status                | Meaning                                                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| `verified_current`    | Confirmed through an authorized Twitch API call or participating-channel event |
| `observed_recent`     | Role badge was observed in chat within the configured recent window            |
| `observed_historical` | Role badge was observed previously but current status is unknown               |
| `external_unverified` | Imported from an external provider and not independently confirmed             |
| `expired`             | Evidence exceeded its allowed freshness window                                 |
| `conflicting`         | Two sources disagree and the conflict has not been resolved                    |

Default recent windows:

- Moderator badge: 30 days
- VIP badge: 30 days
- Subscriber badge: 45 days
- Staff/global badge: 30 days
- General channel activity: 90 days

These must be configurable rather than hard-coded into UI logic.

## Technical Stack

Use a TypeScript monorepo managed with `pnpm`.

### Applications

- `apps/web`: Next.js App Router frontend
- `apps/api`: Fastify REST API
- `apps/worker`: background jobs, provider synchronization, role expiration, aggregation
- `apps/ingest`: Twitch EventSub and optional IRC ingestion
- `apps/extension`: Manifest V3 Chromium extension added after the dashboard MVP works

### Shared packages

- `packages/config`: validated environment configuration
- `packages/contracts`: Zod request, response, and event schemas
- `packages/auth`: Twitch OAuth helpers and authorization policy
- `packages/postgres`: PostgreSQL schema, migrations, and repositories
- `packages/clickhouse`: chat-event persistence and analytical queries
- `packages/providers`: external log-provider adapter interfaces
- `packages/ui`: shared UI components
- `packages/eslint-config`
- `packages/typescript-config`

### Infrastructure

- PostgreSQL: users, organizations, channels, OAuth grants, notes, current-role assertions, provider configuration
- ClickHouse: high-volume chat events, badge observations, aggregates
- Redis: cache, distributed locks, rate-limit coordination, BullMQ
- Docker Compose: local development services
- Caddy or Traefik: optional local reverse proxy
- OpenTelemetry: traces and metrics
- Pino: structured logs

## Repository Layout

```text
chatterscope/
├── apps/
│   ├── api/
│   ├── extension/
│   ├── ingest/
│   ├── web/
│   └── worker/
├── packages/
│   ├── auth/
│   ├── clickhouse/
│   ├── config/
│   ├── contracts/
│   ├── eslint-config/
│   ├── postgres/
│   ├── providers/
│   ├── typescript-config/
│   └── ui/
├── infra/
│   ├── clickhouse/
│   ├── postgres/
│   └── docker-compose.yml
├── docs/
│   ├── data-classification.md
│   ├── provider-contract.md
│   ├── retention-policy.md
│   └── threat-model.md
├── .env.example
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

## Source-of-Truth Rules

### Twitch identity

Always use Twitch numeric user IDs as durable identifiers.

Logins and display names are mutable and must not be primary keys. Store their latest value and an optional history.

### Current roles

A moderator or VIP role is `verified_current` only when one of these conditions is true:

- The role was returned by an authorized Twitch API endpoint for the broadcaster.
- A participating broadcaster-authorized EventSub event explicitly added the role and no later removal event exists.
- The role was manually asserted by an authorized channel administrator and marked with the manual source.

A badge seen in a chat message is not proof of a current role after the message timestamp.

### Observed roles

When a chat message contains badges:

- Store the original badge array.
- Normalize recognized badges into role observations.
- Record the channel, chatter, source message, and timestamp.
- Recalculate the latest evidence for that user-channel-role tuple.
- Never rewrite historical evidence when a newer badge appears.

### External providers

External providers are enrichment sources only.

Provider results must retain:

- Provider name
- Provider record ID where available
- Retrieval timestamp
- Original event timestamp
- Raw payload hash
- Confidence classification
- Provider terms or attribution requirements

Do not scrape undocumented Twitch endpoints. Do not bypass authentication. Do not import private logs without explicit authorization from the channel owner.

## Authentication and Authorization

Use Twitch OAuth authorization code flow.

Store refresh tokens encrypted at rest. Never place Twitch tokens in browser local storage.

Required application concepts:

- User
- Organization
- Organization membership
- Participating Twitch channel
- Channel authorization grant
- Moderator access grant
- Provider credential
- Audit event

Roles:

- `owner`
- `admin`
- `moderator`
- `viewer`

Authorization behavior:

- A user may only view raw message text for channels their organization is authorized to access.
- Cross-channel role summaries may be shown when sourced from public observations, but raw message content must follow provider and channel access policy.
- Local notes are private to the organization by default.
- Only owners and admins may connect or remove channels and providers.
- All exports, note edits, role assertions, token changes, and user lookups must be auditable.

## PostgreSQL Schema

Implement migrations equivalent to the following logical schema.

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE membership_role AS ENUM ('owner', 'admin', 'moderator', 'viewer');
CREATE TYPE evidence_status AS ENUM (
  'verified_current',
  'observed_recent',
  'observed_historical',
  'external_unverified',
  'expired',
  'conflicting'
);
CREATE TYPE evidence_source AS ENUM (
  'twitch_api',
  'twitch_eventsub',
  'twitch_irc',
  'external_provider',
  'manual'
);

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_user_id text NOT NULL UNIQUE,
  login text NOT NULL,
  display_name text NOT NULL,
  profile_image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE twitch_users (
  twitch_user_id text PRIMARY KEY,
  login text NOT NULL,
  display_name text NOT NULL,
  account_created_at timestamptz,
  profile_image_url text,
  broadcaster_type text,
  description text,
  fetched_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE twitch_channels (
  twitch_channel_id text PRIMARY KEY REFERENCES twitch_users(twitch_user_id),
  login text NOT NULL,
  display_name text NOT NULL,
  title text,
  game_id text,
  language text,
  fetched_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_channels (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  twitch_channel_id text NOT NULL REFERENCES twitch_channels(twitch_channel_id) ON DELETE CASCADE,
  connected_by_user_id uuid NOT NULL REFERENCES app_users(id),
  enabled boolean NOT NULL DEFAULT true,
  connected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, twitch_channel_id)
);

CREATE TABLE oauth_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  twitch_user_id text NOT NULL,
  access_token_ciphertext bytea NOT NULL,
  refresh_token_ciphertext bytea NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, twitch_user_id)
);

CREATE TABLE role_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_user_id text NOT NULL REFERENCES twitch_users(twitch_user_id),
  twitch_channel_id text NOT NULL REFERENCES twitch_channels(twitch_channel_id),
  role_name text NOT NULL,
  status evidence_status NOT NULL,
  source evidence_source NOT NULL,
  provider_id uuid,
  source_record_id text,
  first_observed_at timestamptz NOT NULL,
  last_observed_at timestamptz NOT NULL,
  verified_at timestamptz,
  expires_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX role_evidence_user_idx
  ON role_evidence (twitch_user_id, last_observed_at DESC);

CREATE INDEX role_evidence_channel_idx
  ON role_evidence (twitch_channel_id, role_name, status);

CREATE TABLE moderation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  twitch_user_id text NOT NULL REFERENCES twitch_users(twitch_user_id),
  twitch_channel_id text REFERENCES twitch_channels(twitch_channel_id),
  author_user_id uuid NOT NULL REFERENCES app_users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  provider_type text NOT NULL,
  name text NOT NULL,
  base_url text,
  encrypted_config bytea,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL,
  cursor jsonb,
  records_read bigint NOT NULL DEFAULT 0,
  records_written bigint NOT NULL DEFAULT 0,
  error text
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

Add a foreign key from `role_evidence.provider_id` to `providers.id` after both tables exist.

## ClickHouse Schema

```sql
CREATE DATABASE IF NOT EXISTS chatterscope;

CREATE TABLE IF NOT EXISTS chatterscope.chat_messages
(
    event_date Date DEFAULT toDate(sent_at),
    message_id String,
    twitch_channel_id String,
    twitch_user_id String,
    user_login LowCardinality(String),
    display_name String,
    message_text String,
    badges Map(LowCardinality(String), String),
    badge_info Map(LowCardinality(String), String),
    color Nullable(String),
    reply_parent_message_id Nullable(String),
    first_message Bool,
    returning_chatter Bool,
    subscriber Bool,
    moderator Bool,
    source LowCardinality(String),
    provider LowCardinality(String),
    raw_payload String,
    sent_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (twitch_channel_id, twitch_user_id, sent_at, message_id)
TTL event_date + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS chatterscope.role_observations
(
    event_date Date DEFAULT toDate(observed_at),
    twitch_channel_id String,
    twitch_user_id String,
    role_name LowCardinality(String),
    role_value String,
    message_id String,
    source LowCardinality(String),
    provider LowCardinality(String),
    observed_at DateTime64(3, 'UTC'),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMM(event_date)
ORDER BY (twitch_user_id, twitch_channel_id, role_name, observed_at, message_id)
TTL event_date + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192;
```

Retention periods must be configurable. Do not remove TTL support; production deployments need bounded retention.

## Provider Contract

Create a provider interface that supports Rustlog-compatible services and future providers without binding the core application to a specific public site.

```ts
export type ProviderUserReference = {
  twitchUserId?: string;
  login?: string;
};

export type ProviderChannelReference = {
  twitchChannelId?: string;
  login?: string;
};

export type ProviderBadge = {
  setId: string;
  id: string;
  info?: string;
};

export type ProviderMessage = {
  providerRecordId: string;
  user: ProviderUserReference;
  channel: ProviderChannelReference;
  messageId?: string;
  messageText: string;
  badges: ProviderBadge[];
  sentAt: string;
  raw: unknown;
};

export type ProviderQuery = {
  user: ProviderUserReference;
  channel?: ProviderChannelReference;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};

export type ProviderQueryResult = {
  messages: ProviderMessage[];
  nextCursor?: string;
};

export interface ChatLogProvider {
  id: string;
  displayName: string;
  testConnection(): Promise<void>;
  resolveUser(reference: ProviderUserReference): Promise<ProviderUserReference>;
  queryMessages(query: ProviderQuery): Promise<ProviderQueryResult>;
}
```

Provider implementation requirements:

- Timeouts
- Exponential backoff
- Concurrency limit
- Provider-specific rate limiter
- Schema validation
- Raw payload hashing
- Cursor persistence
- Idempotent ingestion
- User-agent identifying the application
- No browser automation
- No CAPTCHA bypass
- No use of undocumented authenticated endpoints

Initial provider implementations:

1. `RustlogCompatibleProvider`
2. `JsonFixtureProvider` for local tests
3. `NativeTwitchProvider` for messages collected directly by this deployment

Do not make Supa or any single public log site a hard dependency. Public services may change, limit access, remove logs, or have incompatible retention policies.

## Twitch Ingestion

Prefer Twitch EventSub for new channel chat ingestion.

Support IRC only as an optional compatibility transport. Keep the normalized event contract identical regardless of transport.

The normalized chat event must include:

```ts
export type NormalizedChatMessage = {
  messageId: string;
  twitchChannelId: string;
  twitchUserId: string;
  userLogin: string;
  displayName: string;
  messageText: string;
  badges: Array<{
    setId: string;
    id: string;
    info?: string;
  }>;
  color?: string;
  replyParentMessageId?: string;
  firstMessage: boolean;
  returningChatter: boolean;
  sentAt: string;
  source: "eventsub" | "irc" | "external";
  provider: string;
  raw: unknown;
};
```

The ingest application must:

1. Validate the incoming message.
2. Deduplicate by source and message ID.
3. Upsert Twitch identity cache.
4. Write the message to ClickHouse.
5. Expand recognized badges into role observations.
6. Queue a role-evidence aggregation job.
7. Update cached user profile summaries.
8. Emit structured telemetry.

Recognized badge mappings must be data-driven.

Initial mappings:

```json
{
  "broadcaster": "broadcaster",
  "moderator": "moderator",
  "vip": "vip",
  "subscriber": "subscriber",
  "founder": "founder",
  "staff": "staff",
  "admin": "admin",
  "global_mod": "global_moderator"
}
```

Unknown badges must be preserved but not automatically interpreted as roles.

## Role Aggregation

For every user-channel-role tuple, compute:

- First observed timestamp
- Last observed timestamp
- Latest source
- Latest provider
- Message count containing the badge
- Verification timestamp
- Expiration timestamp
- Current evidence status
- Conflicting evidence

Priority order:

1. Verified Twitch API result
2. Authorized EventSub add/remove event
3. Manual organization assertion
4. Native chat badge observation
5. External provider observation

A newer lower-priority source must not silently override a higher-priority verified state.

If a verified removal event is received:

- End the current verified role assertion.
- Preserve prior observations.
- Set the summary to `expired` or `observed_historical`.
- Do not delete history.

## REST API

All API responses must use shared Zod contracts.

### Identity

```text
GET /v1/twitch/users/resolve?login={login}
GET /v1/twitch/users/{twitchUserId}
```

### Chatter profile

```text
GET /v1/chatters/{twitchUserId}/profile
GET /v1/chatters/{twitchUserId}/channels
GET /v1/chatters/{twitchUserId}/roles
GET /v1/chatters/{twitchUserId}/messages
GET /v1/chatters/{twitchUserId}/notes
```

Profile query parameters:

```text
organizationId
currentChannelId
from
to
role
status
source
includeMessageText
limit
cursor
```

### Notes

```text
POST /v1/chatters/{twitchUserId}/notes
PATCH /v1/chatters/{twitchUserId}/notes/{noteId}
DELETE /v1/chatters/{twitchUserId}/notes/{noteId}
```

### Providers

```text
GET /v1/providers
POST /v1/providers
POST /v1/providers/{providerId}/test
POST /v1/providers/{providerId}/sync
DELETE /v1/providers/{providerId}
```

### Participating channels

```text
GET /v1/channels
POST /v1/channels/connect
POST /v1/channels/{twitchChannelId}/refresh-roles
DELETE /v1/channels/{twitchChannelId}
```

## Profile Response

```json
{
  "user": {
    "twitchUserId": "141981764",
    "login": "exampleuser",
    "displayName": "ExampleUser",
    "accountCreatedAt": "2017-04-12T18:24:30Z",
    "profileImageUrl": "https://example.invalid/profile.png",
    "fetchedAt": "2026-07-18T17:00:00Z"
  },
  "currentChannel": {
    "twitchChannelId": "12826",
    "relationship": {
      "roles": [
        {
          "role": "viewer",
          "status": "verified_current",
          "source": "twitch_api",
          "lastCheckedAt": "2026-07-18T17:00:00Z"
        }
      ]
    }
  },
  "summary": {
    "channelsObserved": 12,
    "messagesObserved": 1842,
    "firstObservedAt": "2021-06-05T14:12:10Z",
    "lastObservedAt": "2026-07-17T23:42:01Z"
  },
  "roles": [
    {
      "channel": {
        "twitchChannelId": "10001",
        "login": "channel_one",
        "displayName": "Channel One"
      },
      "role": "moderator",
      "status": "observed_recent",
      "source": "twitch_irc",
      "firstObservedAt": "2024-01-05T04:03:02Z",
      "lastObservedAt": "2026-07-17T23:42:01Z",
      "verifiedAt": null,
      "expiresAt": "2026-08-16T23:42:01Z",
      "evidenceCount": 523
    }
  ],
  "warnings": [
    {
      "code": "INCOMPLETE_COVERAGE",
      "message": "Results only include connected channels and configured log providers."
    }
  ]
}
```

## Web Interface

### Routes

```text
/login
/dashboard
/search
/chatter/[twitchUserId]
/channels
/providers
/settings/retention
/settings/audit
```

### Profile page layout

Header:

- Avatar
- Display name
- Login
- Numeric Twitch ID
- Account creation date
- Copy-link action
- Refresh action
- Coverage warning

Summary cards:

- Channels observed
- Messages observed
- Verified current roles
- Historical role observations
- First observed
- Last observed

Role table columns:

- Channel
- Role
- Status
- Source
- First observed
- Last observed
- Verified
- Evidence count

Message table columns:

- Timestamp
- Channel
- Message
- Badges
- Provider
- Source

Notes panel:

- Existing organization notes
- Add note
- Edit own note
- Audit history

Every status must have both a visual badge and plain text. Do not rely on color alone.

### Search behavior

The search box must accept:

- Twitch login
- Twitch profile URL
- Numeric Twitch user ID

Normalize profile URLs and logins before resolving the Twitch ID.

Debounce autocomplete, but require an explicit search submission before loading message history.

## Browser Extension Phase

Build only after the dashboard and API are complete.

Manifest V3 extension behavior:

- Authenticate through the ChatterScope web application.
- Add a `Research in ChatterScope` action when a Twitch username is selected or clicked.
- Open a side panel rather than replacing Twitch’s native viewer card.
- Pass only the Twitch login or ID to the API.
- Render the same profile contract used by the web application.
- Avoid storing OAuth refresh tokens in the extension.
- Treat Twitch DOM selectors as unstable and isolate them in one adapter.
- Fail closed when the username cannot be resolved confidently.
- Never intercept or alter moderation actions.

Do not build automated banning, timeout execution, or chat-message deletion into the first extension release.

## Caching

Suggested cache keys:

```text
twitch:user:{userId}
twitch:login:{normalizedLogin}
profile:{organizationId}:{userId}:{currentChannelId}
roles:{organizationId}:{userId}
provider-lock:{providerId}
```

Suggested TTL values:

- Twitch user identity: 6 hours
- Channel metadata: 15 minutes while live, 6 hours otherwise
- Chatter profile aggregate: 60 seconds
- Verified roles: 5 minutes
- Negative user resolution: 5 minutes

Invalidate profile caches whenever messages, role events, notes, or provider syncs affect the user.

## Security Requirements

- Validate all environment variables at startup.
- Encrypt provider secrets and Twitch refresh tokens.
- Use HTTP-only, secure, same-site cookies.
- Implement CSRF protection for browser mutations.
- Enforce organization boundaries in repository methods, not only route handlers.
- Parameterize all SQL queries.
- Apply pagination limits server-side.
- Escape rendered message text.
- Do not render arbitrary message HTML.
- Add API rate limiting by user and organization.
- Log access to raw messages.
- Redact tokens, cookies, and provider secrets from logs.
- Verify EventSub signatures before processing webhook events.
- Reject webhook timestamps outside the configured replay window.
- Deduplicate EventSub message IDs.
- Add SSRF protection to provider base URLs.
- Block provider URLs resolving to loopback, link-local, and private networks unless explicitly enabled for self-hosted deployments.
- Protect CSV and JSON exports against formula injection and oversized exports.
- Include account and organization deletion workflows.
- Add a retention job that permanently removes expired data.

## Privacy and Moderation Guardrails

- Present facts, sources, and timestamps rather than conclusions.
- Never label a person as safe, unsafe, trusted, malicious, toxic, or suspicious solely from role history.
- A role in another channel is context, not character evidence.
- Hide deleted-message text when the applicable source requires deletion.
- Allow participating channels to remove imported data associated with their channel.
- Allow an administrator to disable message-text storage while retaining badge observations.
- Support hashing message text when deployments only need role observations.
- Clearly disclose incomplete provider coverage.
- Do not infer protected traits or political, religious, medical, sexual, or demographic attributes from messages.
- Do not create cross-platform identity graphs.

## Observability

Emit metrics for:

```text
chat_messages_ingested_total
chat_messages_deduplicated_total
role_observations_created_total
provider_requests_total
provider_request_failures_total
provider_sync_duration_seconds
twitch_api_requests_total
twitch_api_rate_limit_remaining
profile_query_duration_seconds
profile_cache_hits_total
eventsub_signature_failures_total
retention_rows_deleted_total
```

Every request log must include:

- Request ID
- Organization ID when authenticated
- Actor user ID when authenticated
- Route
- Status
- Duration
- Trace ID

Never log message text by default.

## Testing

### Unit tests

- Login normalization
- Twitch profile URL parsing
- Badge normalization
- Evidence status transitions
- Evidence priority conflict resolution
- Role expiration
- Provider pagination
- Provider retry behavior
- EventSub signature verification
- Organization authorization
- Retention calculations

### Integration tests

- PostgreSQL repositories
- ClickHouse inserts and aggregation queries
- Redis caching
- Twitch API client using mocked HTTP
- Rustlog-compatible provider using fixture server
- Worker idempotency
- OAuth callback
- Complete profile endpoint

### End-to-end tests

Use Playwright.

Required scenarios:

1. User signs in and reaches dashboard.
2. User searches by login.
3. User searches by Twitch URL.
4. User opens a chatter with no observations.
5. User opens a chatter with verified and historical roles.
6. User filters by channel and source.
7. User adds and edits a note.
8. Unauthorized organization member cannot read private notes.
9. Coverage warning appears when no providers are configured.
10. Expired evidence does not display as current.

## Seed Data

Create deterministic seed data containing:

- Two organizations
- Three connected Twitch channels
- Five Twitch users
- One verified moderator role
- One verified VIP role
- One recent observed moderator badge
- One historical VIP badge
- One conflicting role record
- Messages from native Twitch and an external provider
- Local moderation notes belonging to separate organizations

No real Twitch users or messages should appear in seed data.

## Local Development

Expected startup flow:

```bash
corepack enable
pnpm install
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Required root scripts:

```json
{
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev --parallel",
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:e2e": "turbo run test:e2e",
    "db:migrate": "pnpm --filter @chatterscope/postgres migrate",
    "db:seed": "pnpm --filter @chatterscope/postgres seed",
    "format": "prettier --write ."
  }
}
```

## Environment Variables

```dotenv
NODE_ENV=development
WEB_ORIGIN=http://localhost:3000
API_ORIGIN=http://localhost:4000

POSTGRES_URL=postgresql://chatterscope:chatterscope@localhost:5432/chatterscope
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_DATABASE=chatterscope
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=
REDIS_URL=redis://localhost:6379

SESSION_SECRET=
ENCRYPTION_KEY=
TWITCH_CLIENT_ID=
TWITCH_CLIENT_SECRET=
TWITCH_REDIRECT_URI=http://localhost:4000/v1/auth/twitch/callback
TWITCH_EVENTSUB_SECRET=

MESSAGE_RETENTION_DAYS=365
ROLE_RECENT_DAYS=30
ALLOW_PRIVATE_PROVIDER_NETWORKS=false
LOG_LEVEL=info
```

Generate `SESSION_SECRET`, `ENCRYPTION_KEY`, and `TWITCH_EVENTSUB_SECRET`; do not provide insecure defaults.

## Initial Delivery Order

### Milestone 1 — Repository and infrastructure

Deliver:

- pnpm monorepo
- TypeScript configuration
- Docker Compose
- PostgreSQL migration system
- ClickHouse initialization
- Redis connection
- Health endpoints
- CI workflow
- README with exact local startup commands

Acceptance:

- `pnpm install` succeeds
- `docker compose up -d` succeeds
- `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test` succeed
- API health endpoint verifies all three data services

### Milestone 2 — Twitch identity and authentication

Deliver:

- Twitch OAuth
- Encrypted token storage
- User resolution
- Twitch user caching
- Organization and membership setup
- Protected API routes

Acceptance:

- A Twitch user can sign in
- Search by login, ID, and profile URL resolves to one canonical user
- Organization boundary tests pass

### Milestone 3 — Native chat ingestion

Deliver:

- EventSub transport
- Webhook signature verification
- Chat normalization
- ClickHouse persistence
- Badge-to-role observation expansion
- Deduplication
- Ingest telemetry

Acceptance:

- Fixture EventSub messages are ingested exactly once
- Badge observations are queryable by user and channel
- Unknown badges are retained without being misclassified

### Milestone 4 — Chatter profile API

Deliver:

- Profile aggregate
- Role evidence state machine
- Channel activity summary
- Message pagination
- Coverage warnings
- Cache invalidation

Acceptance:

- Profile response matches the shared contract
- Current and observed roles cannot be confused
- Conflicting sources remain visible
- Queries remain paginated and organization-scoped

### Milestone 5 — Web dashboard

Deliver:

- Search page
- Chatter profile
- Role and message filters
- Notes
- Provider settings
- Audit screen
- Responsive layout
- Accessible status labels

Acceptance:

- All required Playwright scenarios pass
- No raw token appears in browser storage
- Coverage warnings are visible
- Message text is safely escaped

### Milestone 6 — External provider framework

Deliver:

- Provider interface
- Rustlog-compatible adapter
- Fixture adapter
- Provider configuration UI
- Sync worker
- Backoff, rate limiting, and cursor persistence

Acceptance:

- Sync restart is idempotent
- A provider outage does not block native data
- Every imported message preserves provenance
- Provider deletion does not silently delete native observations

### Milestone 7 — Browser extension

Deliver:

- Manifest V3 project
- Side panel
- Secure app authentication
- Username extraction adapter
- Profile lookup
- Manual username fallback

Acceptance:

- Clicking a recognized Twitch username opens the correct profile
- Failed extraction cannot query the wrong account
- The extension performs no moderation action
- No refresh token is stored in extension storage

## Agent Execution Contract

When this handoff is opened in VS Code:

1. Inspect the existing repository before changing anything.
2. Do not assume the repository is empty.
3. If files already exist, preserve working conventions unless they conflict with security or project requirements.
4. Implement the milestones in order.
5. Do not create placeholder functions, mock production paths, TODO-only modules, or conceptual code.
6. Do not skip validation, migrations, tests, or error handling.
7. Keep all service contracts typed and shared.
8. Do not hard-code a specific external log service into profile logic.
9. Do not use undocumented Twitch APIs.
10. Do not claim a role is current unless the evidence meets the source-of-truth rules.
11. Run formatting, linting, type checking, tests, and builds after each milestone.
12. Record material architecture changes in `docs/architecture-decisions.md`.
13. Stop and report a concrete blocker only when credentials, external authorization, or a policy decision is actually required.
14. Never replace real implementation with pseudocode.

## First VS Code Task

Start with Milestone 1.

Create the complete repository scaffold, infrastructure configuration, package manifests, strict TypeScript configuration, database migration framework, ClickHouse initialization, Redis client, API health endpoint, CI workflow, and README.

The health response must have this shape:

```json
{
  "status": "ok",
  "services": {
    "postgres": "ok",
    "clickhouse": "ok",
    "redis": "ok"
  },
  "version": "0.1.0",
  "timestamp": "2026-07-18T00:00:00.000Z"
}
```

Return the complete files created or modified, the commands run, and their results. Do not begin Twitch OAuth or ingestion until Milestone 1 passes.

## Current Platform Facts to Preserve

- Twitch chat messages provide user, room/channel, message, and badge information through supported chat transports.
- Twitch recommends EventSub and Twitch API for receiving and sending chat, while IRC remains an active compatibility interface.
- Current moderator and VIP lists require appropriate Twitch authorization and cannot be treated as a public global user-role directory.
- The Twitch VIP API can filter a broadcaster’s VIP list for specific user IDs, but the broadcaster authorization requirement still applies.
- A Rustlog-compatible provider can supply historical chat evidence, but its coverage and freshness are provider-specific.
- JustLog is archived and points users to Rustlog as a compatible replacement using ClickHouse.

Before implementing Twitch-specific behavior, verify endpoint scopes and payloads against the current official Twitch Developer documentation.
