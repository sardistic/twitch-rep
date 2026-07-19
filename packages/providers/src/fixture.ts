import type {
  ChatLogProvider,
  ProviderMessage,
  ProviderQuery,
  ProviderQueryResult,
  ProviderUserReference,
} from "./types.js";

/** In-memory provider for tests and local development. */
export class JsonFixtureProvider implements ChatLogProvider {
  readonly id: string;
  readonly displayName: string;

  constructor(
    id: string,
    private readonly fixtures: ProviderMessage[],
  ) {
    this.id = id;
    this.displayName = `Fixture (${id})`;
  }

  async testConnection(): Promise<void> {}

  async resolveUser(reference: ProviderUserReference): Promise<ProviderUserReference> {
    return reference;
  }

  async queryMessages(query: ProviderQuery): Promise<ProviderQueryResult> {
    const matches = this.fixtures.filter((m) => {
      const userMatch = query.user.twitchUserId
        ? m.user.twitchUserId === query.user.twitchUserId
        : m.user.login === query.user.login;
      const channelMatch = !query.channel
        ? true
        : query.channel.twitchChannelId
          ? m.channel.twitchChannelId === query.channel.twitchChannelId
          : m.channel.login === query.channel.login;
      return userMatch && channelMatch;
    });
    const offset = query.cursor ? Number(query.cursor) || 0 : 0;
    const page = matches.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;
    return {
      messages: page,
      ...(nextOffset < matches.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }
}
