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

  // This is the Dial-level callbackUrl (the only one carrying our `callId`),
  // reporting on the B-leg (the dialed-out PSTN call) — its fields are
  // `DialBLegStatus`/`DialBLegDuration`, not Twilio-style `CallStatus`/
  // `CallDuration` (those only appear on the separate Application-level
  // hangup event for the inbound Endpoint leg, which has no callId and is
  // rejected above). Confirmed against a live test call.
  const status = params.DialBLegStatus || null;
  const duration = params.DialBLegDuration;

  await prisma.call.updateMany({
    where: { id: callId },
    data: {
      providerStatus: status,
      durationSeconds: duration ? Number(duration) : null,
    },
  });

  return new NextResponse("", { status: 200 });
}
