/**
 * Credential protection (Phase 1.2).
 *
 *  - Tokens are stored AES-256-GCM encrypted at rest (`v1.<iv>.<tag>.<ct>`,
 *    base64url segments) in the settings table — never plaintext.
 *  - Key source: process.env.TOKEN_ENCRYPTION_KEY (hashed via SHA-256 to a
 *    256-bit key). If unset, an EPHEMERAL per-boot key is used: tokens then do
 *    not survive a process restart (documented, intentionally safer than
 *    plaintext persistence).
 *  - Legacy plaintext rows (prefix-less) are read once for migration and are
 *    re-encrypted on the next write.
 *  - The decrypt path never runs in API response code; the token is never
 *    returned to the browser, and engine error strings redact bearer values.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

let ephemeralKey: Buffer | null = null;

export function secretKeySource(): "env" | "ephemeral" {
  return process.env.TOKEN_ENCRYPTION_KEY ? "env" : "ephemeral";
}

function key(): Buffer {
  const env = process.env.TOKEN_ENCRYPTION_KEY;
  if (env && env.length > 0) {
    return createHash("sha256").update(env, "utf8").digest();
  }
  if (!ephemeralKey) ephemeralKey = randomBytes(32);
  return ephemeralKey;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

export function decryptSecret(payload: string): string | null {
  try {
    if (!payload.startsWith("v1.")) {
      // legacy plaintext row: treat value as plaintext (re-encrypted on next write)
      return payload.length > 0 ? payload : null;
    }
    const [, ivB, tagB, ctB] = payload.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null; // key mismatch (ephemeral across restarts) — force re-login
  }
}
