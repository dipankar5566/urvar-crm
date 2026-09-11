import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getPlivoQueryParams,
  getPlivoRequestUrl,
  isValidPlivoSignature,
  parsePlivoFormBody,
} from "@/lib/plivo";

export async function POST(req: NextRequest) {
  const formParams = await parsePlivoFormBody(req);
  const url = getPlivoRequestUrl(req);
  if (!isValidPlivoSignature(req, url, formParams)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = { ...formParams, ...getPlivoQueryParams(req) };
  const callId = req.nextUrl.searchParams.get("callId");
  if (!callId) return new NextResponse("Missing callId", { status: 400 });

  // Two distinct callback shapes land here, both carrying our `callId`:
  // - The Dial-level callbackUrl (human/Phase 1 calls, which have a
  //   <Dial>) — fields are `DialBLegStatus`/`DialBLegDuration`, not
  //   Twilio-style `CallStatus`/`CallDuration` (confirmed against a live
  //   test call).
  // - Phase 2 AI_AUTONOMOUS calls' plain per-call `hangupUrl` (no <Dial> at
  //   all) — field names not yet confirmed live; falls back to the
  //   documented Plivo hangup fields (`CallStatus`/`Duration`) and logs the
  //   raw params so a real Phase 2 call confirms/corrects this.
  const status = params.DialBLegStatus || params.CallStatus || null;
  const duration = params.DialBLegDuration ?? params.Duration;
  if (!params.DialBLegStatus) {
    console.log(`[status ${callId}] non-Dial hangup callback: ${JSON.stringify(params).slice(0, 500)}`);
  }

  await prisma.call.updateMany({
    where: { id: callId },
    data: {
      providerStatus: status,
      durationSeconds: duration ? Number(duration) : null,
    },
  });

  return new NextResponse("", { status: 200 });
}
