import { describe, expect, it } from "vitest";
import { normalizeLogin, parseTwitchProfileUrl, parseUserSearchInput } from "./normalize.js";

describe("normalizeLogin", () => {
  it("lowercases and strips @", () => {
    expect(normalizeLogin("ExampleUser")).toBe("exampleuser");
    expect(normalizeLogin("@Some_Mod")).toBe("some_mod");
    expect(normalizeLogin("  spaced  ")).toBe("spaced");
  });

  it("rejects invalid logins", () => {
    expect(normalizeLogin("")).toBeNull();
    expect(normalizeLogin("has space")).toBeNull();
    expect(normalizeLogin("way-too-hyphenated")).toBeNull();
    expect(normalizeLogin("a".repeat(26))).toBeNull();
  });
});

describe("parseTwitchProfileUrl", () => {
  it("extracts logins from profile URLs", () => {
    expect(parseTwitchProfileUrl("https://twitch.tv/ExampleUser")).toBe("exampleuser");
    expect(parseTwitchProfileUrl("https://www.twitch.tv/example_user/")).toBe("example_user");
    expect(parseTwitchProfileUrl("twitch.tv/someone")).toBe("someone");
    expect(parseTwitchProfileUrl("https://m.twitch.tv/someone/videos")).toBe("someone");
  });

  it("rejects non-Twitch hosts and reserved paths", () => {
    expect(parseTwitchProfileUrl("https://example.com/user")).toBeNull();
    expect(parseTwitchProfileUrl("https://twitch.tv.evil.com/user")).toBeNull();
    expect(parseTwitchProfileUrl("https://twitch.tv/directory/game/x")).toBeNull();
    expect(parseTwitchProfileUrl("https://twitch.tv/")).toBeNull();
  });
});

describe("parseUserSearchInput", () => {
  it("classifies numeric IDs", () => {
    expect(parseUserSearchInput("141981764")).toEqual({ kind: "id", twitchUserId: "141981764" });
  });

  it("classifies URLs and logins", () => {
    expect(parseUserSearchInput("https://twitch.tv/SomeOne")).toEqual({
      kind: "login",
      login: "someone",
    });
    expect(parseUserSearchInput("@SomeOne")).toEqual({ kind: "login", login: "someone" });
  });

  it("returns null for garbage", () => {
    expect(parseUserSearchInput("")).toBeNull();
    expect(parseUserSearchInput("https://twitch.tv/directory")).toBeNull();
    expect(parseUserSearchInput("not a login!!")).toBeNull();
  });
});
