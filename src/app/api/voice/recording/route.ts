import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTwilioRequestUrl, isValidTwilioSignature, parseTwilioFormBody } from "@/lib/twilio";
import { saveRecordingLocally } from "@/lib/call-recordings";

export async function POST(req: NextRequest) {
  const params = await parseTwilioFormBody(req);
  const url = getTwilioRequestUrl(req);
  if (!isValidTwilioSignature(req.headers.get("X-Twilio-Signature"), url, params)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const callId = req.nextUrl.searchParams.get("callId");
  if (!callId) return new NextResponse("Missing callId", { status: 400 });

  // Twilio posts intermediate statuses (e.g. "in-progress") before the
  // recording is actually ready to download.
  if (params.RecordingStatus && params.RecordingStatus !== "completed") {
    return new NextResponse("", { status: 200 });
  }

  let recordingUrl = params.RecordingUrl || null;
  if (params.RecordingSid && params.RecordingUrl) {
    try {
      recordingUrl = await saveRecordingLocally(params.RecordingSid, params.RecordingUrl);
    } catch (err) {
      console.error(`Failed to save recording ${params.RecordingSid} locally`, err);
    }
  }

  await prisma.call.updateMany({
    where: { id: callId },
    data: {
      recordingUrl,
      recordingSid: params.RecordingSid || null,
    },
  });

  return new NextResponse("", { status: 200 });
}
