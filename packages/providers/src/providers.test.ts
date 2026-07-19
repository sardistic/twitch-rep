import { describe, expect, it } from "vitest";
import { JsonFixtureProvider } from "./fixture.js";
import { parseBadgesFromRawIrc, parseIrcTag } from "./irc-tags.js";
import { RustlogCompatibleProvider } from "./rustlog.js";
import { isPrivateHost, validateProviderBaseUrl } from "./ssrf.js";
import type { ProviderMessage } from "./types.js";

describe("SSRF guard", () => {
  it("accepts public https URLs", () => {
    expect(validateProviderBaseUrl("https://logs.example.org/", false).hostname).toBe(
      "logs.example.org",
    );
  });

  it("rejects private and loopback hosts by default", () => {
    for (const url of [
      "http://localhost:8025",
      "http://127.0.0.1/",
      "http://10.0.200.196/",
      "http://172.16.0.1/",
      "http://192.168.1.10/",
      "http://169.254.1.1/",
      "http://[::1]/",
    ]) {
      expect(() => validateProviderBaseUrl(url, false)).toThrow(/private or local/);
    }
  });

  it("allows private hosts when explicitly enabled", () => {
    expect(validateProviderBaseUrl("http://10.0.0.5:8025", true).hostname).toBe("10.0.0.5");
  });

  it("rejects non-http schemes and embedded credentials", () => {
    expect(() => validateProviderBaseUrl("ftp://logs.example.org", false)).toThrow(/http/);
    expect(() => validateProviderBaseUrl("https://user:pass@logs.example.org", false)).toThrow(
      /credentials/,
    );
  });

  it("classifies hosts", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("100.64.0.1")).toBe(true);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
});

describe("IRC tag parsing", () => {
  const raw =
    "@badge-info=subscriber/14;badges=moderator/1,subscriber/12;color=#00FF00;id=abc-123 :user!user@user.tmi.twitch.tv PRIVMSG #chan :hello";

  it("parses badges with info", () => {
    expect(parseBadgesFromRawIrc(raw)).toEqual([
      { setId: "moderator", id: "1" },
      { setId: "subscriber", id: "12", info: "14" },
    ]);
  });

  it("parses individual tags", () => {
    expect(parseIrcTag(raw, "id")).toBe("abc-123");
    expect(parseIrcTag(raw, "missing")).toBeNull();
  });

  it("handles messages without tags", () => {
    expect(parseBadgesFromRawIrc("PRIVMSG #chan :hi")).toEqual([]);
  });
});

describe("RustlogCompatibleProvider", () => {
  function provider(responses: Array<{ status: number; body: unknown }>) {
    const calls: string[] = [];
    let i = 0;
    const fetchImpl = async (url: string) => {
      calls.push(url);
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    };
    return {
      provider: new RustlogCompatibleProvider({
        id: "p1",
        displayName: "Test Rustlog",
        baseUrl: "https://logs.example.org/",
        allowPrivateNetworks: false,
        fetchImpl,
        maxRetries: 1,
        timeoutMs: 1000,
      }),
      calls,
    };
  }

  const sample = {
    messages: [
      {
        text: "hello",
        username: "SomeUser",
        displayName: "SomeUser",
        channel: "SomeChannel",
        timestamp: "2024-05-01T10:00:00Z",
        raw: "@badges=vip/1;id=m-1 :someuser!x@x PRIVMSG #somechannel :hello",
      },
    ],
  };

  it("queries by channel+user login and normalizes messages", async () => {
    const { provider: p, calls } = provider([{ status: 200, body: sample }]);
    const result = await p.queryMessages({
      user: { login: "someuser" },
      channel: { login: "somechannel" },
      limit: 100,
    });
    expect(calls[0]).toContain("/channel/somechannel/user/someuser");
    expect(result.messages).toHaveLength(1);
    const m = result.messages[0]!;
    expect(m.messageId).toBe("m-1");
    expect(m.badges).toEqual([{ setId: "vip", id: "1" }]);
    expect(m.user.login).toBe("someuser");
    expect(m.sentAt).toBe("2024-05-01T10:00:00.000Z");
  });

  it("prefers numeric id endpoints when ids are available", async () => {
    const { provider: p, calls } = provider([{ status: 200, body: { messages: [] } }]);
    await p.queryMessages({
      user: { twitchUserId: "123" },
      channel: { twitchChannelId: "456" },
      limit: 10,
    });
    expect(calls[0]).toContain("/channelid/456/userid/123");
  });

  it("returns empty on 404 (no logs) instead of failing", async () => {
    const { provider: p } = provider([{ status: 404, body: {} }]);
    const result = await p.queryMessages({
      user: { login: "nobody" },
      channel: { login: "chan" },
      limit: 10,
    });
    expect(result.messages).toEqual([]);
  });

  it("retries on 5xx then succeeds", async () => {
    const { provider: p, calls } = provider([
      { status: 500, body: {} },
      { status: 200, body: sample },
    ]);
    const result = await p.queryMessages({
      user: { login: "someuser" },
      channel: { login: "chan" },
      limit: 10,
    });
    expect(calls).toHaveLength(2);
    expect(result.messages).toHaveLength(1);
  });

  it("rejects schema-invalid responses", async () => {
    const { provider: p } = provider([{ status: 200, body: { unexpected: true } }]);
    await expect(
      p.queryMessages({ user: { login: "u" }, channel: { login: "c" }, limit: 10 }),
    ).rejects.toThrow(/schema/);
  });

  it("requires a channel", async () => {
    const { provider: p } = provider([{ status: 200, body: sample }]);
    await expect(p.queryMessages({ user: { login: "u" }, limit: 10 })).rejects.toThrow(/channel/);
  });
});

describe("JsonFixtureProvider", () => {
  const fixtures: ProviderMessage[] = [0, 1, 2].map((i) => ({
    providerRecordId: `r${i}`,
    user: { login: "fixture_user" },
    channel: { login: "fixture_chan" },
    messageText: `msg ${i}`,
    badges: [],
    sentAt: "2024-01-01T00:00:00.000Z",
    raw: {},
  }));

  it("filters and paginates with cursors", async () => {
    const p = new JsonFixtureProvider("fx", fixtures);
    const page1 = await p.queryMessages({ user: { login: "fixture_user" }, limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.nextCursor).toBe("2");
    const page2 = await p.queryMessages({
      user: { login: "fixture_user" },
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.messages).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    const none = await p.queryMessages({ user: { login: "other" }, limit: 2 });
    expect(none.messages).toEqual([]);
  });
});
