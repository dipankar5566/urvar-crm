import { createHmac, timingSafeEqual } from "crypto";

/**
 * Short-lived signed token authorizing a browser's live-assist WebSocket
 * connection (`getAssistToken` server action -> `live-assist-panel.tsx` ->
 * voice-agent's /assist/{callId} handler). The voice-agent process can't
 * read Better Auth session cookies (it's a standalone process, not part of
 * the Next.js app), so it validates this token independently instead.
 */
const TTL_MS = 5 * 60 * 1000;

function secret(): string {
  const value = process.env.VOICE_AGENT_TOKEN_SECRET;
  if (!value) throw new Error("Missing required env var: VOICE_AGENT_TOKEN_SECRET");
  return value;
}

type AssistTokenPayload = { callId: string; userId: string; exp: number };

export function issueAssistToken(callId: string, userId: string): string {
  const payload: AssistTokenPayload = { callId, userId, exp: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verifies the token's signature, expiry, and that it was issued for this exact call. */
export function verifyAssistToken(token: string, expectedCallId: string): boolean {
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;

  const expectedSig = createHmac("sha256", secret()).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  let payload: AssistTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return false;
  }

  return payload.callId === expectedCallId && Date.now() <= payload.exp;
}
