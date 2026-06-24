import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTwilioRequestUrl, isValidTwilioSignature, parseTwilioFormBody } from "@/lib/twilio";

export async function POST(req: NextRequest) {
  const params = await parseTwilioFormBody(req);
  const url = getTwilioRequestUrl(req);
  if (!isValidTwilioSignature(req.headers.get("X-Twilio-Signature"), url, params)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const callId = req.nextUrl.searchParams.get("callId");
  if (!callId) return new NextResponse("Missing callId", { status: 400 });

  await prisma.call.updateMany({
    where: { id: callId },
    data: {
      providerStatus: params.CallStatus || null,
      durationSeconds: params.CallDuration ? Number(params.CallDuration) : null,
    },
  });

  return new NextResponse("", { status: 200 });
}
