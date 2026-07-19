import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ChatLogProvider,
  ProviderMessage,
  ProviderQuery,
  ProviderQueryResult,
  ProviderUserReference,
} from "./types.js";
import { parseBadgesFromRawIrc, parseIrcTag } from "./irc-tags.js";
import { validateProviderBaseUrl } from "./ssrf.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const rustlogMessageSchema = z.object({
  text: z.string(),
  username: z.string(),
  displayName: z.string().optional().default(""),
  channel: z.string(),
  timestamp: z.string(),
  id: z.string().optional(),
  raw: z.string().optional().default(""),
  tags: z.record(z.string()).optional(),
});
const rustlogResponseSchema = z.object({ messages: z.array(rustlogMessageSchema) });

export type RustlogProviderOptions = {
  id: string;
  displayName: string;
  baseUrl: string;
  allowPrivateNetworks: boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxRetries?: number;
  userAgent?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 3;
const USER_AGENT = "ChatterScope/0.1 (moderation research; provider adapter)";

export function hashRawPayload(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(raw)).digest("hex");
}

/**
 * Adapter for Rustlog-compatible log services (justlog API shape).
 * Queries GET {base}/channel/{channel}/user/{user}?json (or userid/channelid
 * variants when numeric IDs are provided).
 */
export class RustlogCompatibleProvider implements ChatLogProvider {
  readonly id: string;
  readonly displayName: string;
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly userAgent: string;

  constructor(options: RustlogProviderOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.baseUrl = validateProviderBaseUrl(options.baseUrl, options.allowPrivateNetworks);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
    this.userAgent = options.userAgent ?? USER_AGENT;
  }

  private async request(path: string): Promise<Response> {
    const url = new URL(path, this.baseUrl).toString();
    let lastError: Error = new Error("no attempts made");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter: 0.5s, 1s, 2s (+/- 25%).
        const base = 500 * 2 ** (attempt - 1);
        await new Promise((r) => setTimeout(r, base * (0.75 + Math.random() * 0.5)));
      }
      try {
        const response = await this.fetchImpl(url, {
          headers: { "user-agent": this.userAgent, accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`provider returned ${response.status}`);
          continue;
        }
        return response;
      } catch (error) {
        lastError = error as Error;
      }
    }
    throw new Error(
      `Provider request failed after ${this.maxRetries + 1} attempts: ${lastError.message}`,
    );
  }

  async testConnection(): Promise<void> {
    const response = await this.request("channels");
    if (!response.ok) {
      throw new Error(`Provider test failed: /channels returned ${response.status}`);
    }
  }

  async resolveUser(reference: ProviderUserReference): Promise<ProviderUserReference> {
    // Rustlog has no standalone user-resolution endpoint; pass through.
    return reference;
  }

  async queryMessages(query: ProviderQuery): Promise<ProviderQueryResult> {
    if (!query.channel?.login && !query.channel?.twitchChannelId) {
      throw new Error("Rustlog-compatible providers require a channel to query");
    }
    const channelPart = query.channel.twitchChannelId
      ? `channelid/${encodeURIComponent(query.channel.twitchChannelId)}`
      : `channel/${encodeURIComponent(query.channel.login!)}`;
    const userPart = query.user.twitchUserId
      ? `userid/${encodeURIComponent(query.user.twitchUserId)}`
      : `user/${encodeURIComponent(query.user.login ?? "")}`;
    if (userPart === "user/") throw new Error("A user login or id is required");

    const response = await this.request(`${channelPart}/${userPart}?json=1`);
    if (response.status === 404) return { messages: [] };
    if (!response.ok) throw new Error(`Provider query returned ${response.status}`);

    const parsed = rustlogResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Provider response failed schema validation");

    const limited = parsed.data.messages.slice(0, Math.max(1, query.limit));
    const messages: ProviderMessage[] = limited.map((m) => {
      const messageId = m.id || (m.raw ? (parseIrcTag(m.raw, "id") ?? undefined) : undefined);
      return {
        providerRecordId: messageId ?? hashRawPayload([m.channel, m.username, m.timestamp, m.text]),
        user: { login: m.username.toLowerCase() },
        channel: { login: m.channel.toLowerCase() },
        ...(messageId ? { messageId } : {}),
        messageText: m.text,
        badges: m.raw ? parseBadgesFromRawIrc(m.raw) : [],
        sentAt: new Date(m.timestamp).toISOString(),
        raw: m,
      };
    });
    return { messages };
  }
}
