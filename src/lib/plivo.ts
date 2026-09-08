// Namespace import, not default — confirmed via isolated repro that
// `import plivo from "plivo"` resolves to `undefined` when this file is
// loaded through voice-agent's tsx/CJS-interop bridge (Node's ESM->CJS
// loader path for a nested .ts import), even though the same default
// import works fine under Next.js's own bundler. A namespace import
// resolves correctly in both contexts since every usage below is a
// property access (`plivo.Client`, `plivo.validateV3Signature`), never a
// direct call of `plivo` itself.
import * as plivo from "plivo";
import { createHash, randomBytes } from "crypto";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { encrypt, decrypt } from "@/lib/crypto";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const plivoClient = new plivo.Client(env("PLIVO_AUTH_ID"), env("PLIVO_AUTH_TOKEN"));

/**
 * Returns this user's persistent Plivo SIP Endpoint credentials for the
 * Browser SDK, creating one lazily on first use. Unlike Twilio's ephemeral
 * AccessToken (~1hr TTL, regenerated per call), a Plivo Endpoint is a
 * long-lived credential — created once, stored (password encrypted at
 * rest), and reused across sessions.
 */
export async function getOrCreateEndpoint(
  userId: string,
): Promise<{ username: string; password: string }> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { plivoEndpointId: true, plivoUsername: true, plivoPasswordEncrypted: true },
  });

  if (user.plivoEndpointId && user.plivoUsername && user.plivoPasswordEncrypted) {
    return { username: user.plivoUsername, password: decrypt(user.plivoPasswordEncrypted) };
  }

  // Plivo Endpoint usernames must be strictly alphanumeric, max 25 chars —
  // our (Better Auth) user ids are 32 chars, too long to use directly, so
  // hash down to a short deterministic value instead.
  const username = createHash("sha256").update(userId).digest("hex").slice(0, 24);
  const password = randomBytes(18).toString("base64url");

  // appId binds this Endpoint's outbound calls to our Application's
  // answer_url — without it Plivo has nowhere to route the call.
  const created = await plivoClient.endpoints.create(
    username,
    password,
    `urvar_crm_${userId}`,
    env("PLIVO_APP_ID"),
  );

  // Plivo's response `username` doesn't always match what was requested (it
  // silently appended a numeric suffix in testing) — trust the response,
  // never the locally-generated value, or the stored credential won't match
  // what Plivo actually registered.
  const actualUsername = created.username || username;

  await prisma.user.update({
    where: { id: userId },
    data: {
      plivoEndpointId: created.endpointId,
      plivoUsername: actualUsername,
      plivoPasswordEncrypted: encrypt(password),
    },
  });

  return { username: actualUsername, password };
}

/**
 * Reconstructs the exact URL Plivo used to sign the request, query string
 * included — `X-Plivo-Signature-V3` covers it, and the Browser SDK's
 * `X-PH-*` extraHeaders arrive appended as query params on this URL. `req.url`'s
 * scheme can read as `http` behind a TLS-terminating tunnel/proxy (Cloudflare
 * Tunnel in prod), which would otherwise break signature validation.
 */
export function getPlivoRequestUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`;
}

/** Parses a Plivo `application/x-www-form-urlencoded` webhook body. */
export async function parsePlivoFormBody(req: NextRequest): Promise<Record<string, string>> {
  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    params[key] = value;
  }
  return params;
}

/** Query-string params on the request — where Plivo delivers `X-PH-*` extraHeaders. */
export function getPlivoQueryParams(req: NextRequest): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of req.nextUrl.searchParams) {
    params[key] = value;
  }
  return params;
}

/**
 * Validates the `X-Plivo-Signature-V3` header on inbound voice webhooks.
 * `formParams` must be the parsed POST body only — `validateV3Signature`
 * merges the URL's own query string into the signed payload internally, so
 * passing query params here as well would double-count them.
 */
export function isValidPlivoSignature(
  req: NextRequest,
  url: string,
  formParams: Record<string, string>,
): boolean {
  const nonce = req.headers.get("X-Plivo-Signature-V3-Nonce");
  const signature = req.headers.get("X-Plivo-Signature-V3");
  if (!nonce || !signature) return false;
  // The SDK's .d.ts declares a `Boolean` wrapper return type; the runtime
  // value is already a primitive, `Boolean(...)` just satisfies the types.
  return Boolean(
    plivo.validateV3Signature(req.method, url, nonce, env("PLIVO_AUTH_TOKEN"), signature, formParams),
  );
}

export { plivo };
