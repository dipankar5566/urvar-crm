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
  console.log(`[ai-answer] hit for callId=${callId}, CallUUID=${params.CallUUID}, params=${JSON.stringify(params).slice(0, 300)}`);

  const response = plivo.Response();

  const call = callId
    ? await prisma.call.findUnique({ where: { id: callId } })
    : null;
  const voiceAgentUrl = process.env.VOICE_AGENT_PUBLIC_URL;

  // Single-use authorization, same reasoning as answer/route.ts.
  if (!call || call.provider !== "PLIVO" || call.callMode !== "AI_AUTONOMOUS" || call.providerCallSid) {
    console.log(
      `[ai-answer] rejected: call=${!!call}, provider=${call?.provider}, callMode=${call?.callMode}, existingProviderCallSid=${call?.providerCallSid}`,
    );
    response.addSpeak("Sorry, this call could not be authorized. Goodbye.");
    response.addHangup({});
    return xml(response);
  }

  await prisma.call.update({
    where: { id: call.id },
    data: { providerCallSid: params.CallUUID || null },
  });

  if (!voiceAgentUrl) {
    console.log("[ai-answer] VOICE_AGENT_PUBLIC_URL is not set — falling back to hangup");
    response.addSpeak("Sorry, the AI calling service is not available right now. Goodbye.");
    response.addHangup({});
    return xml(response);
  }

  const origin = new URL(url).origin;
  // Kept short deliberately: this <Speak> blocks, and every second of it is
  // dead air before <Stream> can open and the AI can greet.
  response.addSpeak("This call is recorded for quality purposes.");
  // recordSession is load-bearing, not a nicety. A plain <Record> runs in the
  // FOREGROUND and holds the XML queue until it finishes (maxLength 60s, or
  // `timeout` 15s of silence), so <Stream> below didn't open until a minute
  // in — calls shorter than that got no AI at all, and longer ones got an AI
  // that woke up after ~60s of silence. Confirmed from the tunnel request
  // timeline: /plivo-stream opened in the same second as the /recording
  // callback on every call, and never at all on a 52s call. recordSession
  // records the whole session in the background instead, so execution falls
  // straight through to <Stream>; completion is delivered to `callbackUrl`
  // (not `action`) which recording/route.ts already handles.
  // maxLength is NOT ignored under recordSession, despite the docs only
  // listing timeout/finishOnKey/playBeep as ignored — measured on a live
  // 89s call that came back with ~65s of audio and a recording callback
  // 60s in, well before hangup. 1800s is deliberately conservative: Plivo
  // documents the 60s default and a 120s example but never states a
  // maximum, and a rejected attribute would take the whole XML (and with
  // it every AI call) down, which is a far worse failure than a truncated
  // recording of an unusually long call.
  response.addRecord({
    action: `${origin}/api/voice/plivo/recording?callId=${call.id}`,
    callbackUrl: `${origin}/api/voice/plivo/recording?callId=${call.id}`,
    callbackMethod: "POST",
    redirect: "false",
    recordSession: true,
    maxLength: 1800,
    fileFormat: "mp3",
  });
  // Bidirectional streaming: Plivo requires audioTrack to stay "inbound"
  // (the default) whenever bidirectional is true — "both"/"outbound" are
  // rejected (confirmed against Plivo's own Audio Streaming docs).
  const streamUrl = `${voiceAgentUrl}/plivo-stream?callId=${call.id}`;
  response.addStream(streamUrl, {
    bidirectional: true,
    contentType: "audio/x-l16;rate=16000",
    keepCallAlive: true,
  });

  const xmlBody = response.toXML();
  console.log(`[ai-answer] returning XML with stream=${streamUrl}: ${xmlBody}`);
  return new NextResponse(xmlBody, { headers: { "Content-Type": "text/xml" } });
}
