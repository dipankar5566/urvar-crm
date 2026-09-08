import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  getPlivoQueryParams,
  getPlivoRequestUrl,
  getOrCreateEndpoint,
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
 * Live-transfer target for Phase 2's transfer_to_human tool
 * (voice-agent/tools/crm-tools.ts calls plivoClient.calls.transfer() with
 * this route as the alegUrl). Reuses getOrCreateEndpoint + addDial exactly
 * like the existing human-initiated call flow (answer/route.ts) rings a
 * rep's SIP Endpoint.
 *
 * This route is hit twice per transfer: once with no DialBLegStatus (the
 * initial redirect — build the <Dial>), and again as the Dial's own
 * `action` callback once it completes, carrying DialBLegStatus (the same
 * field name the existing status/route.ts already confirmed Plivo uses for
 * B-leg outcomes, not Twilio-style DialStatus) — if that isn't "answer",
 * degrade to a voicemail-style message and flag the call for a callback
 * rather than silently dropping the lead.
 */
export async function POST(req: NextRequest) {
  const formParams = await parsePlivoFormBody(req);
  const url = getPlivoRequestUrl(req);
  if (!isValidPlivoSignature(req, url, formParams)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const params = { ...formParams, ...getPlivoQueryParams(req) };
  const callId = params.callId;
  const repId = params.repId;
  const origin = new URL(url).origin;

  const response = plivo.Response();
  const call = callId ? await prisma.call.findUnique({ where: { id: callId } }) : null;
  if (!call || !call.leadId) {
    response.addHangup({});
    return xml(response);
  }

  const isPostDialCallback = "DialBLegStatus" in params;
  const dialSucceeded = params.DialBLegStatus === "answer";

  if (isPostDialCallback && !dialSucceeded) {
    response.addSpeak("Sorry, our team is unavailable right now. We will call you back soon.");
    response.addHangup({});

    const lead = await prisma.lead.findUnique({
      where: { id: call.leadId },
      select: { assignedToId: true },
    });
    const assignedToId = lead?.assignedToId ?? process.env.AI_CALL_FALLBACK_USER_ID ?? null;
    if (assignedToId) {
      const followUp = await prisma.followUp.create({
        data: {
          leadId: call.leadId,
          assignedToId,
          priority: "HIGH",
          dueAt: new Date(Date.now() + 60 * 60 * 1000),
          notes: "AI call transfer to human went unanswered — needs a callback.",
        },
      });
      await prisma.call.update({
        where: { id: call.id },
        data: { outcome: "TRANSFERRED_TO_HUMAN", followUpId: followUp.id },
      });
      await prisma.leadActivity.create({
        data: {
          leadId: call.leadId,
          type: "CALL_LOGGED",
          description: "AI call transfer to human went unanswered — flagged for callback.",
          createdById: assignedToId,
          metadata: { callId: call.id },
        },
      });
    }
    return xml(response);
  }

  if (isPostDialCallback && dialSucceeded) {
    // Dial completed successfully — nothing further to do, the rep and
    // lead are now talking directly.
    return xml(response);
  }

  if (!repId) {
    response.addSpeak("Sorry, no representative is available. Goodbye.");
    response.addHangup({});
    return xml(response);
  }

  const { username } = await getOrCreateEndpoint(repId);
  await prisma.call.update({
    where: { id: call.id },
    data: { transferredToUserId: repId },
  });

  const dial = response.addDial({
    action: `${origin}/api/voice/plivo/transfer?callId=${call.id}&repId=${repId}`,
    timeout: 30,
  });
  dial.addUser(`sip:${username}@phone.plivo.com`, {});

  return xml(response);
}
