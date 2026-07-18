import { z } from "zod";
import type { NormalizedChatMessage } from "@chatterscope/contracts";

/** Subset of the EventSub channel.chat.message event payload we consume. */
export const chatMessageEventSchema = z.object({
  broadcaster_user_id: z.string(),
  broadcaster_user_login: z.string(),
  broadcaster_user_name: z.string(),
  chatter_user_id: z.string(),
  chatter_user_login: z.string(),
  chatter_user_name: z.string(),
  message_id: z.string(),
  message: z.object({ text: z.string() }),
  color: z.string().optional().default(""),
  badges: z
    .array(z.object({ set_id: z.string(), id: z.string(), info: z.string().optional() }))
    .optional()
    .default([]),
  reply: z.object({ parent_message_id: z.string() }).nullish(),
});

export type ChatMessageEvent = z.infer<typeof chatMessageEventSchema>;

export function normalizeChatMessageEvent(
  event: ChatMessageEvent,
  sentAt: string,
  raw: unknown,
): NormalizedChatMessage {
  return {
    messageId: event.message_id,
    twitchChannelId: event.broadcaster_user_id,
    twitchUserId: event.chatter_user_id,
    userLogin: event.chatter_user_login,
    displayName: event.chatter_user_name,
    messageText: event.message.text,
    badges: event.badges.map((badge) => {
      const normalized: NormalizedChatMessage["badges"][number] = {
        setId: badge.set_id,
        id: badge.id,
      };
      if (badge.info !== undefined) normalized.info = badge.info;
      return normalized;
    }),
    ...(event.color ? { color: event.color } : {}),
    ...(event.reply?.parent_message_id
      ? { replyParentMessageId: event.reply.parent_message_id }
      : {}),
    // channel.chat.message does not carry first/returning flags; they arrive
    // via IRC tags only. False here means "not asserted", never "verified no".
    firstMessage: false,
    returningChatter: false,
    sentAt,
    source: "eventsub",
    provider: "native",
    raw,
  };
}
