import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM secret sealing for tokens at rest.
 * Ciphertext layout: 12-byte IV || 16-byte auth tag || ciphertext.
 * The key is derived from ENCRYPTION_KEY with SHA-256 so any >=32-char
 * secret works while the cipher always gets exactly 32 key bytes.
 */
export function deriveKey(encryptionKey: string): Buffer {
  if (encryptionKey.length < 32) {
    throw new Error("encryption key must be at least 32 characters");
  }
  return createHash("sha256").update(encryptionKey, "utf8").digest();
}

export function encryptSecret(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

export function decryptSecret(sealed: Buffer, key: Buffer): string {
  if (sealed.length < 12 + 16) {
    throw new Error("sealed secret is too short to be valid");
  }
  const iv = sealed.subarray(0, 12);
  const tag = sealed.subarray(12, 28);
  const ciphertext = sealed.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
