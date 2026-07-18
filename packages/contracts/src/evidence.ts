import type { EvidenceSource, EvidenceStatus } from "./index.js";

/** Aggregated badge observations for one user-channel-role tuple. */
export type RoleObservationAggregate = {
  twitchChannelId: string;
  roleName: string;
  firstObservedAt: Date;
  lastObservedAt: Date;
  observationCount: number;
  latestSource: EvidenceSource;
  latestProvider: string;
};

/** A verified (or manually asserted) role state from the relational store. */
export type VerifiedAssertion = {
  twitchChannelId: string;
  roleName: string;
  source: Extract<EvidenceSource, "twitch_api" | "twitch_eventsub" | "manual">;
  verifiedAt: Date;
  /** null = still current; a past date = the role verifiably ended then. */
  endedAt: Date | null;
};

export type RecentWindowsDays = Readonly<Record<string, number>> & { readonly default: number };

/** Handoff defaults; deployments override via configuration, never UI logic. */
export const DEFAULT_RECENT_WINDOWS_DAYS: RecentWindowsDays = {
  moderator: 30,
  vip: 30,
  subscriber: 45,
  founder: 45,
  staff: 30,
  admin: 30,
  global_moderator: 30,
  default: 90,
};

export function recentWindowDays(roleName: string, windows: RecentWindowsDays): number {
  return windows[roleName] ?? windows.default;
}

export type RoleEvidenceSummary = {
  twitchChannelId: string;
  roleName: string;
  status: EvidenceStatus;
  source: EvidenceSource;
  provider: string | null;
  firstObservedAt: Date | null;
  lastObservedAt: Date | null;
  verifiedAt: Date | null;
  expiresAt: Date | null;
  evidenceCount: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Role evidence state machine. Combines badge observations with verified
 * assertions for one user-channel-role tuple and produces the display status.
 *
 * Priority rules (per the handoff):
 * - A current verified assertion always wins: `verified_current`.
 * - A verified *ended* role with a badge observed after the end is `conflicting`
 *   (a newer lower-priority source must not silently override verified state).
 * - Otherwise observations age through `observed_recent` / `external_unverified`
 *   (within the role's recent window) into `observed_historical`; a previously
 *   verified role with no newer observations becomes `expired`.
 */
export function computeRoleEvidence(
  observation: RoleObservationAggregate | null,
  assertion: VerifiedAssertion | null,
  now: Date,
  windows: RecentWindowsDays = DEFAULT_RECENT_WINDOWS_DAYS,
): RoleEvidenceSummary | null {
  if (!observation && !assertion) return null;

  const channelId = observation?.twitchChannelId ?? assertion!.twitchChannelId;
  const roleName = observation?.roleName ?? assertion!.roleName;
  const windowMs = recentWindowDays(roleName, windows) * DAY_MS;

  const base = {
    twitchChannelId: channelId,
    roleName,
    firstObservedAt: observation?.firstObservedAt ?? null,
    lastObservedAt: observation?.lastObservedAt ?? null,
    evidenceCount: observation?.observationCount ?? 0,
  };

  if (assertion && assertion.endedAt === null) {
    return {
      ...base,
      status: "verified_current",
      source: assertion.source,
      provider: null,
      verifiedAt: assertion.verifiedAt,
      expiresAt: null,
    };
  }

  if (assertion && assertion.endedAt !== null) {
    const observedAfterEnd =
      observation && observation.lastObservedAt.getTime() > assertion.endedAt.getTime();
    if (observedAfterEnd) {
      return {
        ...base,
        status: "conflicting",
        source: observation.latestSource,
        provider: observation.latestProvider,
        verifiedAt: assertion.verifiedAt,
        expiresAt: assertion.endedAt,
      };
    }
    return {
      ...base,
      status: "expired",
      source: assertion.source,
      provider: null,
      verifiedAt: assertion.verifiedAt,
      expiresAt: assertion.endedAt,
    };
  }

  // Observation only.
  const obs = observation!;
  const age = now.getTime() - obs.lastObservedAt.getTime();
  const withinWindow = age <= windowMs;
  const status: EvidenceStatus = withinWindow
    ? obs.latestSource === "external_provider"
      ? "external_unverified"
      : "observed_recent"
    : "observed_historical";
  return {
    ...base,
    status,
    source: obs.latestSource,
    provider: obs.latestProvider,
    verifiedAt: null,
    expiresAt: withinWindow ? new Date(obs.lastObservedAt.getTime() + windowMs) : null,
  };
}
