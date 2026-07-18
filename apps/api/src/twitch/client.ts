import { z } from "zod";
import { fetchAppAccessToken, type FetchLike, type TwitchTokens } from "@chatterscope/auth";

const helixUserSchema = z.object({
  id: z.string(),
  login: z.string(),
  display_name: z.string(),
  broadcaster_type: z.string(),
  description: z.string(),
  profile_image_url: z.string(),
  created_at: z.string(),
});
const helixUsersResponseSchema = z.object({ data: z.array(helixUserSchema) });

export type HelixUser = {
  twitchUserId: string;
  login: string;
  displayName: string;
  accountCreatedAt: Date;
  profileImageUrl: string | null;
  broadcasterType: string | null;
  description: string | null;
};

export interface TwitchApi {
  getUserByLogin(login: string): Promise<HelixUser | null>;
  getUserById(twitchUserId: string): Promise<HelixUser | null>;
  getUserForToken(userAccessToken: string): Promise<HelixUser | null>;
}

function toHelixUser(user: z.infer<typeof helixUserSchema>): HelixUser {
  return {
    twitchUserId: user.id,
    login: user.login,
    displayName: user.display_name,
    accountCreatedAt: new Date(user.created_at),
    profileImageUrl: user.profile_image_url || null,
    broadcasterType: user.broadcaster_type || null,
    description: user.description || null,
  };
}

export class HelixClient implements TwitchApi {
  private appToken: TwitchTokens | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async getAppToken(): Promise<string> {
    if (!this.appToken || this.appToken.expiresAt.getTime() - 60_000 < Date.now()) {
      this.appToken = await fetchAppAccessToken(
        { clientId: this.clientId, clientSecret: this.clientSecret },
        this.fetchImpl,
      );
    }
    return this.appToken.accessToken;
  }

  private async getUsers(query: string, token?: string): Promise<HelixUser[]> {
    const accessToken = token ?? (await this.getAppToken());
    const response = await this.fetchImpl(`https://api.twitch.tv/helix/users${query}`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        "client-id": this.clientId,
      },
    });
    if (response.status === 401 && !token) {
      // App token revoked or expired early: refresh once and retry.
      this.appToken = null;
      return this.getUsers(query);
    }
    if (!response.ok) {
      throw new Error(`Twitch Helix /users returned ${response.status}`);
    }
    const parsed = helixUsersResponseSchema.parse(await response.json());
    return parsed.data.map(toHelixUser);
  }

  async getUserByLogin(login: string): Promise<HelixUser | null> {
    const users = await this.getUsers(`?login=${encodeURIComponent(login)}`);
    return users[0] ?? null;
  }

  async getUserById(twitchUserId: string): Promise<HelixUser | null> {
    const users = await this.getUsers(`?id=${encodeURIComponent(twitchUserId)}`);
    return users[0] ?? null;
  }

  async getUserForToken(userAccessToken: string): Promise<HelixUser | null> {
    const users = await this.getUsers("", userAccessToken);
    return users[0] ?? null;
  }
}
