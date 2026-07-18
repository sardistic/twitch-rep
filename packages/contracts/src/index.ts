import { z } from "zod";

export const membershipRoleSchema = z.enum(["owner", "admin", "moderator", "viewer"]);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const evidenceStatusSchema = z.enum([
  "verified_current",
  "observed_recent",
  "observed_historical",
  "external_unverified",
  "expired",
  "conflicting",
]);
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;

export const evidenceSourceSchema = z.enum([
  "twitch_api",
  "twitch_eventsub",
  "twitch_irc",
  "external_provider",
  "manual",
]);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const twitchUserSchema = z.object({
  twitchUserId: z.string(),
  login: z.string(),
  displayName: z.string(),
  accountCreatedAt: z.string().datetime().nullable(),
  profileImageUrl: z.string().nullable(),
  broadcasterType: z.string().nullable(),
  description: z.string().nullable(),
  fetchedAt: z.string().datetime(),
});
export type TwitchUser = z.infer<typeof twitchUserSchema>;

export const resolveUserResponseSchema = z.object({
  user: twitchUserSchema,
  source: z.enum(["cache", "twitch_api"]),
});
export type ResolveUserResponse = z.infer<typeof resolveUserResponseSchema>;

export const organizationSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: membershipRoleSchema,
});
export type Organization = z.infer<typeof organizationSchema>;

export const meResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    twitchUserId: z.string(),
    login: z.string(),
    displayName: z.string(),
    profileImageUrl: z.string().nullable(),
  }),
  organizations: z.array(organizationSchema),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiError(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export const chatBadgeSchema = z.object({
  setId: z.string(),
  id: z.string(),
  info: z.string().optional(),
});
export type ChatBadge = z.infer<typeof chatBadgeSchema>;

export const normalizedChatMessageSchema = z.object({
  messageId: z.string().min(1),
  twitchChannelId: z.string().min(1),
  twitchUserId: z.string().min(1),
  userLogin: z.string().min(1),
  displayName: z.string().min(1),
  messageText: z.string(),
  badges: z.array(chatBadgeSchema),
  color: z.string().optional(),
  replyParentMessageId: z.string().optional(),
  firstMessage: z.boolean(),
  returningChatter: z.boolean(),
  sentAt: z.string().datetime(),
  source: z.enum(["eventsub", "irc", "external"]),
  provider: z.string().min(1),
  raw: z.unknown(),
});
export type NormalizedChatMessage = z.infer<typeof normalizedChatMessageSchema>;

/**
 * Badge set id → role name. Data-driven per the handoff; unknown badges are
 * preserved in storage but never interpreted as roles.
 */
export const DEFAULT_BADGE_ROLE_MAP: Readonly<Record<string, string>> = {
  broadcaster: "broadcaster",
  moderator: "moderator",
  vip: "vip",
  subscriber: "subscriber",
  founder: "founder",
  staff: "staff",
  admin: "admin",
  global_mod: "global_moderator",
};
