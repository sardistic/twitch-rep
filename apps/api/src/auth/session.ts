import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

export type Session = {
  appUserId: string;
  twitchUserId: string;
  createdAt: string;
};

export interface SessionStore {
  create(session: Session): Promise<string>;
  get(sessionId: string): Promise<Session | null>;
  destroy(sessionId: string): Promise<void>;
  saveOauthState(state: string): Promise<void>;
  consumeOauthState(state: string): Promise<boolean>;
}

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

export class RedisSessionStore implements SessionStore {
  constructor(private readonly redis: Redis) {}

  async create(session: Session): Promise<string> {
    const sessionId = randomBytes(32).toString("hex");
    await this.redis.set(
      `session:${sessionId}`,
      JSON.stringify(session),
      "EX",
      SESSION_TTL_SECONDS,
    );
    return sessionId;
  }

  async get(sessionId: string): Promise<Session | null> {
    if (!/^[0-9a-f]{64}$/.test(sessionId)) return null;
    const raw = await this.redis.get(`session:${sessionId}`);
    return raw ? (JSON.parse(raw) as Session) : null;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.redis.del(`session:${sessionId}`);
  }

  async saveOauthState(state: string): Promise<void> {
    await this.redis.set(`oauth-state:${state}`, "1", "EX", STATE_TTL_SECONDS);
  }

  async consumeOauthState(state: string): Promise<boolean> {
    const deleted = await this.redis.del(`oauth-state:${state}`);
    return deleted === 1;
  }
}

/** In-memory store for tests. Not for production (no expiry, single process). */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly states = new Set<string>();

  async create(session: Session): Promise<string> {
    const sessionId = randomBytes(32).toString("hex");
    this.sessions.set(sessionId, session);
    return sessionId;
  }

  async get(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async destroy(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async saveOauthState(state: string): Promise<void> {
    this.states.add(state);
  }

  async consumeOauthState(state: string): Promise<boolean> {
    return this.states.delete(state);
  }
}
