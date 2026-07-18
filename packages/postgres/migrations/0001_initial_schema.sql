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

CREATE TABLE role_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  twitch_user_id text NOT NULL REFERENCES twitch_users(twitch_user_id),
  twitch_channel_id text NOT NULL REFERENCES twitch_channels(twitch_channel_id),
  role_name text NOT NULL,
  status evidence_status NOT NULL,
  source evidence_source NOT NULL,
  provider_id uuid REFERENCES providers(id),
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
