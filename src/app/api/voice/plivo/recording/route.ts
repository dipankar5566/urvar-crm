import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getPlivoQueryParams,
  getPlivoRequestUrl,
  isValidPlivoSignature,
  parsePlivoFormBody,
} from "@/lib/plivo";
import { saveRecordingLocally } from "@/lib/call-recordings";

export async function POST(req: NextRequest) {
  const formParams = await parsePlivoFormBody(req);
  const url = getPlivoRequestUrl(req);
  if (!isValidPlivoSignature(req, url, formParams)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = { ...formParams, ...getPlivoQueryParams(req) };
  const callId = req.nextUrl.searchParams.get("callId");
  if (!callId) return new NextResponse("Missing callId", { status: 400 });

  // With startOnDialAnswer, Plivo fires an initial callback with duration
  // "-1" before the recording actually finishes — ignore it and wait for
  // the real one. Field names (RecordUrl/RecordingID/RecordingDuration)
  // confirmed against a live test call.
  if (params.RecordingDuration === "-1") {
    return new NextResponse("", { status: 200 });
  }

  const recordingId = params.RecordingID || null;
  const recordingUrl = params.RecordUrl || null;

  let savedPath: string | null = recordingUrl;
  if (recordingId && recordingUrl) {
    try {
      savedPath = await saveRecordingLocally(recordingId, recordingUrl);
    } catch (err) {
      console.error(`Failed to save recording ${recordingId} locally`, err);
    }
  }

  await prisma.call.updateMany({
    where: { id: callId },
    data: {
      recordingUrl: savedPath,
      recordingSid: recordingId,
    },
  });

  return new NextResponse("", { status: 200 });
}
