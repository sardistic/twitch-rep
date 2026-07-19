import type { ProviderBadge } from "./types.js";

/**
 * Extracts badges (and badge-info) from a raw IRC v3 message line, e.g.
 * "@badge-info=subscriber/14;badges=moderator/1,subscriber/12;... PRIVMSG ...".
 * Rustlog-compatible services return the original IRC line in `raw`.
 */
export function parseBadgesFromRawIrc(raw: string): ProviderBadge[] {
  if (!raw.startsWith("@")) return [];
  const tagSection = raw.slice(1).split(" ", 1)[0]!;
  const tags = new Map<string, string>();
  for (const pair of tagSection.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) tags.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  const badgesTag = tags.get("badges");
  if (!badgesTag) return [];
  const badgeInfo = new Map<string, string>();
  for (const entry of (tags.get("badge-info") ?? "").split(",")) {
    const [setId, value] = entry.split("/");
    if (setId && value !== undefined) badgeInfo.set(setId, value);
  }
  const badges: ProviderBadge[] = [];
  for (const entry of badgesTag.split(",")) {
    const [setId, id] = entry.split("/");
    if (!setId || id === undefined) continue;
    const info = badgeInfo.get(setId);
    badges.push(info !== undefined ? { setId, id, info } : { setId, id });
  }
  return badges;
}

/** Extracts a single IRC tag value (e.g. "id" for the message id). */
export function parseIrcTag(raw: string, tag: string): string | null {
  if (!raw.startsWith("@")) return null;
  const tagSection = raw.slice(1).split(" ", 1)[0]!;
  for (const pair of tagSection.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq) === tag) return pair.slice(eq + 1);
  }
  return null;
}
