import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./queries.js";

describe("message pagination cursor", () => {
  it("round-trips", () => {
    const cursor = encodeCursor("2026-07-18 12:00:00.123", "msg-abc");
    expect(decodeCursor(cursor)).toEqual({
      sentAt: "2026-07-18 12:00:00.123",
      messageId: "msg-abc",
    });
  });

  it("rejects garbage and malformed payloads", () => {
    expect(decodeCursor("not-base64!!")).toBeNull();
    expect(decodeCursor(Buffer.from("[1,2]").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from('["drop table","x"]').toString("base64url"))).toBeNull();
  });
});
