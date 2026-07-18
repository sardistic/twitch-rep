import { z } from "zod";

export type TwitchOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.array(z.string()).optional().default([]),
  token_type: z.string(),
});

export type TwitchTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
};

export function buildAuthorizeUrl(
  config: TwitchOAuthConfig,
  state: string,
  scopes: string[] = [],
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function requestToken(
  fetchImpl: FetchLike,
  params: Record<string, string>,
): Promise<TwitchTokens> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Twitch token endpoint returned ${response.status}: ${body.slice(0, 200)}`);
  }
  const parsed = tokenResponseSchema.parse(await response.json());
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
    scopes: parsed.scope,
  };
}

export function exchangeAuthorizationCode(
  config: TwitchOAuthConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<TwitchTokens> {
  return requestToken(fetchImpl, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
  });
}

export function refreshAccessToken(
  config: TwitchOAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<TwitchTokens> {
  return requestToken(fetchImpl, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/** App access token (client credentials) for server-to-server Helix calls. */
export function fetchAppAccessToken(
  config: Pick<TwitchOAuthConfig, "clientId" | "clientSecret">,
  fetchImpl: FetchLike = fetch,
): Promise<TwitchTokens> {
  return requestToken(fetchImpl, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "client_credentials",
  });
}
