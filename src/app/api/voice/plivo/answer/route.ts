import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getPlivoQueryParams,
  getPlivoRequestUrl,
  isValidPlivoSignature,
  parsePlivoFormBody,
  plivo,
} from "@/lib/plivo";
import { toE164 } from "@/lib/phone";

function xml(response: ReturnType<typeof plivo.Response>) {
  return new NextResponse(response.toXML(), {
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(req: NextRequest) {
  const formParams = await parsePlivoFormBody(req);
  const url = getPlivoRequestUrl(req);
  if (!isValidPlivoSignature(req, url, formParams)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // The Browser SDK's `client.call(dest, { "X-PH-CallId": callId })` arrives
  // here as a query param (not the POST body) — confirmed against Plivo's
  // pass-custom-headers docs. Merge query over body so it isn't missed.
  const params = { ...formParams, ...getPlivoQueryParams(req) };
  const callId = params["X-PH-CallId"];

  const response = plivo.Response();

  const call = callId
    ? await prisma.call.findUnique({
        where: { id: callId },
        include: {
          lead: { select: { phone: true } },
          customer: { select: { phone: true } },
        },
      })
    : null;
  const phone = toE164(call?.lead?.phone ?? call?.customer?.phone ?? null);

  // Single-use authorization: `callId` is an unguessable cuid generated
  // server-side by `initiateCall` for a specific authorized user, and this
  // check ensures it hasn't already been consumed by an earlier answer_url
  // hit. Plivo's `From`/`Direction` fields for Endpoint-originated calls are
  // not reliably documented (see migration plan), so we don't gate on them.
  if (!call || call.provider !== "PLIVO" || call.providerCallSid || !phone) {
    response.addSpeak("Sorry, this call could not be authorized. Goodbye.");
    response.addHangup({});
    return xml(response);
  }

  await prisma.call.update({
    where: { id: call.id },
    data: {
      providerCallSid: params.CallUUID || null,
      fromNumber: params.From || null,
      toNumber: phone,
    },
  });

  const origin = new URL(url).origin;
  response.addSpeak("This call may be recorded for quality and training purposes.");
  // Recording is a sibling element in Plivo XML, not nested under Dial.
  response.addRecord({
    action: `${origin}/api/voice/plivo/recording?callId=${call.id}`,
    redirect: "false",
    startOnDialAnswer: "true",
    fileFormat: "mp3",
  });
  const dial = response.addDial({
    callerId: process.env.PLIVO_CALLER_ID,
    callbackUrl: `${origin}/api/voice/plivo/status?callId=${call.id}`,
    callbackMethod: "POST",
  });
  dial.addNumber(phone, {});

  return xml(response);
}
