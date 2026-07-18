import { describe, expect, it } from "vitest";
import { decryptSecret, deriveKey, encryptSecret } from "./crypto.js";

const key = deriveKey("a-test-encryption-key-that-is-long-enough");

describe("secret sealing", () => {
  it("round-trips plaintext", () => {
    const sealed = encryptSecret("twitch-refresh-token-value", key);
    expect(decryptSecret(sealed, key)).toBe("twitch-refresh-token-value");
  });

  it("produces different ciphertext each time (random IV)", () => {
    const a = encryptSecret("same", key);
    const b = encryptSecret("same", key);
    expect(a.equals(b)).toBe(false);
  });

  it("fails on tampered ciphertext", () => {
    const sealed = encryptSecret("secret", key);
    sealed[sealed.length - 1]! ^= 0xff;
    expect(() => decryptSecret(sealed, key)).toThrow();
  });

  it("fails with the wrong key", () => {
    const sealed = encryptSecret("secret", key);
    const otherKey = deriveKey("a-different-encryption-key-thats-also-long");
    expect(() => decryptSecret(sealed, otherKey)).toThrow();
  });

  it("rejects short keys", () => {
    expect(() => deriveKey("short")).toThrow(/32 characters/);
  });

  it("rejects truncated sealed blobs", () => {
    expect(() => decryptSecret(Buffer.from("tiny"), key)).toThrow(/too short/);
  });
});
