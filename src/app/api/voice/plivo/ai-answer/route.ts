import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getPlivoQueryParams,
  getPlivoRequestUrl,
  isValidPlivoSignature,
  parsePlivoFormBody,
  plivo,
} from "@/lib/plivo";

function xml(response: ReturnType<typeof plivo.Response>) {
  return new NextResponse(response.toXML(), {
    headers: { "Content-Type": "text/xml" },
  });
}

/**
 * Answer webhook for Phase 2 AI_AUTONOMOUS calls — REST-initiated via
 * `initiateAiCall`'s `plivoClient.calls.create()`, so callId travels
 * directly in this URL's query string (no browser SDK / X-PH-CallId here).
 * XML is <Speak> (recording consent — AI disclosure line intentionally
 * skipped for now, a deliberate risk accepted per the plan's Non-goals)
 * -> <Record> -> bidirectional <Stream>. No <Dial> — the AI is the far end.
 */
export async function POST(req: NextRequest) {
  const formParams = await parsePlivoFormBody(req);
  const url = getPlivoRequestUrl(req);
  if (!isValidPlivoSignature(req, url, formParams)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = { ...formParams, ...getPlivoQueryParams(req) };
  const callId = params.callId;

  const response = plivo.Response();

  const call = callId
    ? await prisma.call.findUnique({ where: { id: callId } })
    : null;
  const voiceAgentUrl = process.env.VOICE_AGENT_PUBLIC_URL;

  // Single-use authorization, same reasoning as answer/route.ts.
  if (!call || call.provider !== "PLIVO" || call.callMode !== "AI_AUTONOMOUS" || call.providerCallSid) {
    response.addSpeak("Sorry, this call could not be authorized. Goodbye.");
    response.addHangup({});
    return xml(response);
  }

  await prisma.call.update({
    where: { id: call.id },
    data: { providerCallSid: params.CallUUID || null },
  });

  if (!voiceAgentUrl) {
    response.addSpeak("Sorry, the AI calling service is not available right now. Goodbye.");
    response.addHangup({});
    return xml(response);
  }

  const origin = new URL(url).origin;
  response.addSpeak("This call may be recorded for quality and training purposes.");
  response.addRecord({
    action: `${origin}/api/voice/plivo/recording?callId=${call.id}`,
    callbackUrl: `${origin}/api/voice/plivo/recording?callId=${call.id}`,
    callbackMethod: "POST",
    redirect: "false",
    fileFormat: "mp3",
  });
  // Bidirectional streaming: Plivo requires audioTrack to stay "inbound"
  // (the default) whenever bidirectional is true — "both"/"outbound" are
  // rejected (confirmed against Plivo's own Audio Streaming docs).
  response.addStream(`${voiceAgentUrl}/plivo-stream?callId=${call.id}`, {
    bidirectional: true,
    contentType: "audio/x-l16;rate=16000",
    keepCallAlive: true,
  });

  return xml(response);
}
