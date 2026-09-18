import { randomBytes } from "crypto";

/**
 * Opaque bearer capability tokens (currently just Quotation.acceptToken,
 * Phase 6 of the sales-funnel automation roadmap) — never decrypted, unlike
 * crypto.ts's AES-256-GCM at-rest encryption of stored secrets, so this
 * stays a separate, single-purpose module rather than overloading that
 * file's scope.
 */
export function generateAcceptToken(): string {
  // 32 random bytes, base64url-encoded (~43 chars, URL-safe, no padding) —
  // effectively unguessable, so the accept route can rely on token secrecy
  // alone with no additional rate limiting, the same trust model
  // api/documents/[fileId] places in a cuid's unguessability.
  return randomBytes(32).toString("base64url");
}
