import { createHmac, timingSafeEqual } from "node:crypto";

export type EventSubHeaders = {
  messageId: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

export type SignatureCheck =
  | { valid: true }
  | { valid: false; reason: "missing_headers" | "bad_signature" | "stale_timestamp" };

export const REPLAY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Verifies a Twitch EventSub webhook signature:
 * HMAC-SHA256(secret, messageId + timestamp + rawBody) == signature header,
 * and the timestamp is within the replay window.
 */
export function verifyEventSubSignature(
  headers: EventSubHeaders,
  rawBody: string,
  secret: string,
  now: () => Date = () => new Date(),
): SignatureCheck {
  const { messageId, timestamp, signature } = headers;
  if (!messageId || !timestamp || !signature) {
    return { valid: false, reason: "missing_headers" };
  }
  const sentAt = Date.parse(timestamp);
  if (Number.isNaN(sentAt) || Math.abs(now().getTime() - sentAt) > REPLAY_WINDOW_MS) {
    return { valid: false, reason: "stale_timestamp" };
  }
  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(messageId).update(timestamp).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "bad_signature" };
  }
  return { valid: true };
}
