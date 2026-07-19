import { describe, expect, it } from "vitest";
import { channelLoginFromParam, ircToNormalizedMessage, parseIrcLine } from "./parse.js";

const SAMPLE =
  "@badge-info=subscriber/14;badges=moderator/1,subscriber/12;color=#00FF7F;display-name=HelpfulMod;" +
  "first-msg=0;id=abc-123;mod=1;returning-chatter=0;room-id=900000001;subscriber=1;" +
  "tmi-sent-ts=1784400000000;user-id=900000004 " +
  ":helpful_mod!helpful_mod@helpful_mod.tmi.twitch.tv PRIVMSG #alphachannel :hello there";

describe("parseIrcLine", () => {
  it("parses tags, prefix, command, and trailing param", () => {
    const message = parseIrcLine(SAMPLE)!;
    expect(message.command).toBe("PRIVMSG");
    expect(message.tags.get("user-id")).toBe("900000004");
    expect(message.tags.get("display-name")).toBe("HelpfulMod");
    expect(message.prefix).toBe("helpful_mod!helpful_mod@helpful_mod.tmi.twitch.tv");
    expect(message.params).toEqual(["#alphachannel", "hello there"]);
  });

  it("parses PING", () => {
    const ping = parseIrcLine("PING :tmi.twitch.tv")!;
    expect(ping.command).toBe("PING");
    expect(ping.params).toEqual(["tmi.twitch.tv"]);
  });

  it("unescapes tag values", () => {
    const message = parseIrcLine("@system-msg=hi\\sthere\\:) :x NOTICE #c :y")!;
    expect(message.tags.get("system-msg")).toBe("hi there;)");
  });

  it("returns null for empty lines", () => {
    expect(parseIrcLine("")).toBeNull();
  });
});

describe("ircToNormalizedMessage", () => {
  it("maps a PRIVMSG to the normalized contract", () => {
    const normalized = ircToNormalizedMessage(parseIrcLine(SAMPLE)!, SAMPLE)!;
    expect(normalized.messageId).toBe("abc-123");
    expect(normalized.twitchChannelId).toBe("900000001");
    expect(normalized.twitchUserId).toBe("900000004");
    expect(normalized.userLogin).toBe("helpful_mod");
    expect(normalized.displayName).toBe("HelpfulMod");
    expect(normalized.messageText).toBe("hello there");
    expect(normalized.badges).toEqual([
      { setId: "moderator", id: "1" },
      { setId: "subscriber", id: "12", info: "14" },
    ]);
    expect(normalized.sentAt).toBe(new Date(1784400000000).toISOString());
    expect(normalized.source).toBe("irc");
    expect(normalized.firstMessage).toBe(false);
  });

  it("flags first-time chatters", () => {
    const line = SAMPLE.replace("first-msg=0", "first-msg=1");
    expect(ircToNormalizedMessage(parseIrcLine(line)!, line)!.firstMessage).toBe(true);
  });

  it("returns null for non-PRIVMSG and unattributable messages", () => {
    expect(ircToNormalizedMessage(parseIrcLine("PING :x")!, "PING :x")).toBeNull();
    const noUser = "@room-id=1;id=x :tmi.twitch.tv PRIVMSG #c :hi";
    expect(ircToNormalizedMessage(parseIrcLine(noUser)!, noUser)).toBeNull();
  });
});

describe("channelLoginFromParam", () => {
  it("strips the # and lowercases", () => {
    expect(channelLoginFromParam("#AlphaChannel")).toBe("alphachannel");
  });
});
