const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;
const NUMERIC_ID_PATTERN = /^\d{1,20}$/;

export type UserSearchInput =
  { kind: "login"; login: string } | { kind: "id"; twitchUserId: string };

/** Lowercases and strips a leading @; returns null when not a valid login. */
export function normalizeLogin(raw: string): string | null {
  const login = raw.trim().replace(/^@/, "").toLowerCase();
  return LOGIN_PATTERN.test(login) ? login : null;
}

const TWITCH_HOSTS = new Set(["twitch.tv", "www.twitch.tv", "m.twitch.tv"]);
// First path segments that are Twitch site sections, not usernames.
const RESERVED_PATHS = new Set([
  "directory",
  "videos",
  "settings",
  "subscriptions",
  "wallet",
  "friends",
  "search",
  "downloads",
  "jobs",
  "turbo",
  "popout",
  "moderator",
  "p",
  "logout",
]);

/** Extracts a login from a Twitch profile URL, or null if not one. */
export function parseTwitchProfileUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!TWITCH_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0]?.toLowerCase();
  if (!first || RESERVED_PATHS.has(first)) return null;
  return normalizeLogin(first);
}

/**
 * Interprets a search-box input as a numeric Twitch ID, a profile URL, or a
 * login (in that order). Returns null when nothing valid can be extracted.
 */
export function parseUserSearchInput(raw: string): UserSearchInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (NUMERIC_ID_PATTERN.test(trimmed)) {
    return { kind: "id", twitchUserId: trimmed };
  }
  if (trimmed.includes("twitch.tv")) {
    const login = parseTwitchProfileUrl(trimmed);
    return login ? { kind: "login", login } : null;
  }
  const login = normalizeLogin(trimmed);
  return login ? { kind: "login", login } : null;
}
