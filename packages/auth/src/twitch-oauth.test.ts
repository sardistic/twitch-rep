import { describe, expect, it } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  fetchAppAccessToken,
  type TwitchOAuthConfig,
} from "./twitch-oauth.js";

const config: TwitchOAuthConfig = {
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://localhost:4000/v1/auth/twitch/callback",
};

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; body: string }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

describe("buildAuthorizeUrl", () => {
  it("includes client id, redirect, scopes, and state", () => {
    const url = new URL(buildAuthorizeUrl(config, "state-123", ["user:read:email"]));
    expect(url.origin + url.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("scope")).toBe("user:read:email");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});

describe("exchangeAuthorizationCode", () => {
  it("parses a successful token response", async () => {
    const { impl, calls } = fakeFetch(200, {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: ["user:read:email"],
      token_type: "bearer",
    });
    const tokens = await exchangeAuthorizationCode(config, "the-code", impl);
    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(tokens.scopes).toEqual(["user:read:email"]);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(calls[0]!.body).toContain("grant_type=authorization_code");
    expect(calls[0]!.body).toContain("code=the-code");
  });

  it("throws on error responses", async () => {
    const { impl } = fakeFetch(400, { message: "invalid code" });
    await expect(exchangeAuthorizationCode(config, "bad", impl)).rejects.toThrow(/400/);
  });
});

describe("fetchAppAccessToken", () => {
  it("uses client_credentials and tolerates missing refresh_token", async () => {
    const { impl, calls } = fakeFetch(200, {
      access_token: "app-token",
      expires_in: 5000,
      token_type: "bearer",
    });
    const tokens = await fetchAppAccessToken(config, impl);
    expect(tokens.accessToken).toBe("app-token");
    expect(tokens.refreshToken).toBeNull();
    expect(calls[0]!.body).toContain("grant_type=client_credentials");
  });
});
