import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getTwilioRequestUrl,
  isValidTwilioSignature,
  parseTwilioFormBody,
  twilio,
} from "@/lib/twilio";
import { toE164 } from "@/lib/phone";

const { VoiceResponse } = twilio.twiml;

function xml(response: InstanceType<typeof VoiceResponse>) {
  return new NextResponse(response.toString(), {
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(req: NextRequest) {
  const params = await parseTwilioFormBody(req);
  const url = getTwilioRequestUrl(req);
  if (!isValidTwilioSignature(req.headers.get("X-Twilio-Signature"), url, params)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const response = new VoiceResponse();

  // Only WebRTC browser callers (`client:<userId>`) are authorized here —
  // the callId param is client-supplied and untrusted until matched against it.
  const fromIdentity = params.From?.startsWith("client:") ? params.From.slice(7) : null;
  const call = params.callId
    ? await prisma.call.findUnique({
        where: { id: params.callId },
        include: {
          lead: { select: { phone: true } },
          customer: { select: { phone: true } },
        },
      })
    : null;
  const phone = toE164(call?.lead?.phone ?? call?.customer?.phone ?? null);

  if (!call || !fromIdentity || call.userId !== fromIdentity || !phone) {
    response.say("Sorry, this call could not be authorized. Goodbye.");
    response.hangup();
    return xml(response);
  }

  await prisma.call.update({
    where: { id: call.id },
    data: { providerCallSid: params.CallSid || null, fromNumber: params.From, toNumber: phone },
  });

  const origin = new URL(url).origin;
  response.say("This call may be recorded for quality and training purposes.");
  const dial = response.dial({
    callerId: process.env.TWILIO_CALLER_ID,
    record: "record-from-answer",
    recordingStatusCallback: `${origin}/api/voice/recording?callId=${call.id}`,
  });
  dial.number(
    {
      statusCallback: `${origin}/api/voice/status?callId=${call.id}`,
      statusCallbackEvent: ["completed"],
    },
    phone,
  );

  return xml(response);
}
