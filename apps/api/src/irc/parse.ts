import type { NormalizedChatMessage } from "@chatterscope/contracts";

export type IrcMessage = {
  tags: Map<string, string>;
  prefix: string | null;
  command: string;
  params: string[];
};

/** Unescapes IRCv3 tag values (\\s space, \\: semicolon, \\\\ backslash). */
function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) =>
    c === "s" ? " " : c === ":" ? ";" : c === "r" ? "\r" : c === "n" ? "\n" : c,
  );
}

export function parseIrcLine(line: string): IrcMessage | null {
  let rest = line.trim();
  if (!rest) return null;
  const tags = new Map<string, string>();
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ");
    if (space < 0) return null;
    for (const pair of rest.slice(1, space).split(";")) {
      const eq = pair.indexOf("=");
      if (eq > 0) tags.set(pair.slice(0, eq), unescapeTag(pair.slice(eq + 1)));
      else if (pair) tags.set(pair, "");
    }
    rest = rest.slice(space + 1);
  }
  let prefix: string | null = null;
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ");
    if (space < 0) return null;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }
  const params: string[] = [];
  let command = "";
  while (rest.length > 0) {
    if (rest.startsWith(":") && command) {
      params.push(rest.slice(1));
      break;
    }
    const space = rest.indexOf(" ");
    const token = space < 0 ? rest : rest.slice(0, space);
    if (!command) command = token;
    else params.push(token);
    rest = space < 0 ? "" : rest.slice(space + 1);
  }
  if (!command) return null;
  return { tags, prefix, command, params };
}

/**
 * Converts a Twitch IRC PRIVMSG into the normalized chat contract.
 * Returns null for anything that is not an attributable chat message.
 */
export function ircToNormalizedMessage(
  message: IrcMessage,
  rawLine: string,
): NormalizedChatMessage | null {
  if (message.command !== "PRIVMSG") return null;
  const channelParam = message.params[0];
  const text = message.params[1] ?? "";
  const roomId = message.tags.get("room-id");
  const userId = message.tags.get("user-id");
  const messageId = message.tags.get("id");
  const login = message.prefix?.split("!")[0];
  if (!channelParam || !roomId || !userId || !messageId || !login) return null;

  const badges: NormalizedChatMessage["badges"] = [];
  const badgeInfo = new Map<string, string>();
  for (const entry of (message.tags.get("badge-info") ?? "").split(",")) {
    const [setId, value] = entry.split("/");
    if (setId && value !== undefined) badgeInfo.set(setId, value);
  }
  for (const entry of (message.tags.get("badges") ?? "").split(",")) {
    const [setId, id] = entry.split("/");
    if (!setId || id === undefined) continue;
    const info = badgeInfo.get(setId);
    badges.push(info !== undefined ? { setId, id, info } : { setId, id });
  }

  const sentTs = Number(message.tags.get("tmi-sent-ts"));
  const color = message.tags.get("color");
  const replyParent = message.tags.get("reply-parent-msg-id");
  return {
    messageId,
    twitchChannelId: roomId,
    twitchUserId: userId,
    userLogin: login.toLowerCase(),
    displayName: message.tags.get("display-name") || login,
    messageText: text,
    badges,
    ...(color ? { color } : {}),
    ...(replyParent ? { replyParentMessageId: replyParent } : {}),
    firstMessage: message.tags.get("first-msg") === "1",
    returningChatter: message.tags.get("returning-chatter") === "1",
    sentAt: new Date(Number.isFinite(sentTs) && sentTs > 0 ? sentTs : Date.now()).toISOString(),
    source: "irc",
    provider: "native",
    raw: rawLine,
  };
}

/** Channel login from a PRIVMSG param ("#somechannel" → "somechannel"). */
export function channelLoginFromParam(param: string): string {
  return param.replace(/^#/, "").toLowerCase();
}
