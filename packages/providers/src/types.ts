export type ProviderUserReference = {
  twitchUserId?: string;
  login?: string;
};

export type ProviderChannelReference = {
  twitchChannelId?: string;
  login?: string;
};

export type ProviderBadge = {
  setId: string;
  id: string;
  info?: string;
};

export type ProviderMessage = {
  providerRecordId: string;
  user: ProviderUserReference;
  channel: ProviderChannelReference;
  messageId?: string;
  messageText: string;
  badges: ProviderBadge[];
  sentAt: string;
  raw: unknown;
};

export type ProviderQuery = {
  user: ProviderUserReference;
  channel?: ProviderChannelReference;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
};

export type ProviderQueryResult = {
  messages: ProviderMessage[];
  nextCursor?: string;
};

export interface ChatLogProvider {
  id: string;
  displayName: string;
  testConnection(): Promise<void>;
  resolveUser(reference: ProviderUserReference): Promise<ProviderUserReference>;
  queryMessages(query: ProviderQuery): Promise<ProviderQueryResult>;
}
