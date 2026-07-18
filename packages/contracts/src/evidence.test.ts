import { describe, expect, it } from "vitest";
import {
  computeRoleEvidence,
  DEFAULT_RECENT_WINDOWS_DAYS,
  recentWindowDays,
  type RoleObservationAggregate,
  type VerifiedAssertion,
} from "./evidence.js";

const NOW = new Date("2026-07-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function obs(overrides: Partial<RoleObservationAggregate> = {}): RoleObservationAggregate {
  return {
    twitchChannelId: "chan1",
    roleName: "moderator",
    firstObservedAt: new Date(NOW.getTime() - 100 * DAY),
    lastObservedAt: new Date(NOW.getTime() - 2 * DAY),
    observationCount: 42,
    latestSource: "twitch_eventsub",
    latestProvider: "native",
    ...overrides,
  };
}

function assertion(overrides: Partial<VerifiedAssertion> = {}): VerifiedAssertion {
  return {
    twitchChannelId: "chan1",
    roleName: "moderator",
    source: "twitch_api",
    verifiedAt: new Date(NOW.getTime() - 1 * DAY),
    endedAt: null,
    ...overrides,
  };
}

describe("recentWindowDays", () => {
  it("uses role-specific windows with a default fallback", () => {
    expect(recentWindowDays("moderator", DEFAULT_RECENT_WINDOWS_DAYS)).toBe(30);
    expect(recentWindowDays("subscriber", DEFAULT_RECENT_WINDOWS_DAYS)).toBe(45);
    expect(recentWindowDays("something_else", DEFAULT_RECENT_WINDOWS_DAYS)).toBe(90);
  });
});

describe("computeRoleEvidence", () => {
  it("returns null with no evidence at all", () => {
    expect(computeRoleEvidence(null, null, NOW)).toBeNull();
  });

  it("verified current assertion wins over any observation age", () => {
    const result = computeRoleEvidence(obs(), assertion(), NOW)!;
    expect(result.status).toBe("verified_current");
    expect(result.source).toBe("twitch_api");
    expect(result.verifiedAt).toEqual(assertion().verifiedAt);
    expect(result.evidenceCount).toBe(42);
  });

  it("a newer badge observation does not override a verified removal — it conflicts", () => {
    const ended = assertion({ endedAt: new Date(NOW.getTime() - 5 * DAY) });
    const newerBadge = obs({ lastObservedAt: new Date(NOW.getTime() - 1 * DAY) });
    const result = computeRoleEvidence(newerBadge, ended, NOW)!;
    expect(result.status).toBe("conflicting");
    expect(result.source).toBe("twitch_eventsub");
  });

  it("a verified removal with no newer observations is expired, history preserved", () => {
    const ended = assertion({ endedAt: new Date(NOW.getTime() - 5 * DAY) });
    const olderBadge = obs({ lastObservedAt: new Date(NOW.getTime() - 10 * DAY) });
    const result = computeRoleEvidence(olderBadge, ended, NOW)!;
    expect(result.status).toBe("expired");
    expect(result.firstObservedAt).toEqual(olderBadge.firstObservedAt);
    expect(result.evidenceCount).toBe(42);
  });

  it("recent native observation is observed_recent with a computed expiry", () => {
    const result = computeRoleEvidence(obs(), null, NOW)!;
    expect(result.status).toBe("observed_recent");
    expect(result.expiresAt).toEqual(new Date(obs().lastObservedAt.getTime() + 30 * DAY));
  });

  it("recent external observation is external_unverified, never observed_recent", () => {
    const result = computeRoleEvidence(
      obs({ latestSource: "external_provider", latestProvider: "rustlog" }),
      null,
      NOW,
    )!;
    expect(result.status).toBe("external_unverified");
    expect(result.provider).toBe("rustlog");
  });

  it("observations older than the role window become observed_historical", () => {
    const result = computeRoleEvidence(
      obs({ lastObservedAt: new Date(NOW.getTime() - 31 * DAY) }),
      null,
      NOW,
    )!;
    expect(result.status).toBe("observed_historical");
    expect(result.expiresAt).toBeNull();
  });

  it("subscriber uses the 45-day window", () => {
    const result = computeRoleEvidence(
      obs({ roleName: "subscriber", lastObservedAt: new Date(NOW.getTime() - 40 * DAY) }),
      null,
      NOW,
    )!;
    expect(result.status).toBe("observed_recent");
  });

  it("assertion-only tuples (never observed in chat) still render", () => {
    const result = computeRoleEvidence(null, assertion(), NOW)!;
    expect(result.status).toBe("verified_current");
    expect(result.firstObservedAt).toBeNull();
    expect(result.evidenceCount).toBe(0);
  });
});
