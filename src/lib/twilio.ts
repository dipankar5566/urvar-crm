import twilio from "twilio";
import type { NextRequest } from "next/server";

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Access Token for the browser Twilio Voice SDK (`Device`). One per call, ~1hr TTL. */
export function generateVoiceAccessToken(identity: string): string {
  const token = new AccessToken(
    env("TWILIO_ACCOUNT_SID"),
    env("TWILIO_API_KEY_SID"),
    env("TWILIO_API_KEY_SECRET"),
    { identity, ttl: 3600 },
  );
  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: env("TWILIO_TWIML_APP_SID"),
      incomingAllow: false,
    }),
  );
  return token.toJwt();
}

/** Validates the `X-Twilio-Signature` header on inbound voice webhooks. */
export function isValidTwilioSignature(
  signature: string | null,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  return twilio.validateRequest(env("TWILIO_AUTH_TOKEN"), signature, url, params);
}

/**
 * Reconstructs the exact URL Twilio used to sign the request. `req.url`'s
 * scheme can read as `http` behind a TLS-terminating tunnel/proxy (e.g.
 * ngrok in dev), which would otherwise break signature validation.
 */
export function getTwilioRequestUrl(req: NextRequest): string {
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return `${proto}://${host}${req.nextUrl.pathname}${req.nextUrl.search}`;
}

/** Parses a Twilio `application/x-www-form-urlencoded` webhook body. */
export async function parseTwilioFormBody(req: NextRequest): Promise<Record<string, string>> {
  const raw = await req.text();
  const params: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    params[key] = value;
  }
  return params;
}

export { twilio };
