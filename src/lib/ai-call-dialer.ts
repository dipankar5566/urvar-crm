import { prisma } from "@/lib/prisma";
import { plivoClient } from "@/lib/plivo";
import { toE164 } from "@/lib/phone";

type DialResult = { success: true; id: string } | { error: string };

/**
 * Places a fully autonomous AI outbound call to a lead — the actual dialing
 * logic, extracted from initiateAiCall (calls/ai-voice-actions.ts) so it's
 * callable from a cron context too (Phase 7 of the sales-funnel automation
 * roadmap), which has no requireUser()/session to authorize through.
 *
 * Deliberately does its own fresh, unscoped lead lookup rather than trusting
 * a caller's row — same "re-fetch rather than trust the caller's row"
 * pattern quotation-notify.ts already uses. The human-facing action
 * (initiateAiCall) still does its own scoped authorization check before
 * calling this; this function itself performs none, so only trusted
 * server-side callers (the dashboard action, or the Phase 7 cron sweep)
 * should call it directly.
 */
export async function dialAiCall(leadId: string): Promise<DialResult> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, deletedAt: null },
    select: { id: true, phone: true, doNotCall: true },
  });
  if (!lead) return { error: "Lead not found or access denied." };
  if (lead.doNotCall) return { error: "This lead is marked do-not-call." };

  const phone = toE164(lead.phone);
  if (!phone) return { error: "Lead has no valid phone number." };

  const call = await prisma.call.create({
    data: {
      leadId: lead.id,
      userId: null,
      direction: "OUTBOUND",
      provider: "PLIVO",
      callMode: "AI_AUTONOMOUS",
    },
  });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const callerId = process.env.PLIVO_CALLER_ID;
  if (!appUrl || !callerId) {
    await prisma.call.delete({ where: { id: call.id } });
    return { error: "Voice calling isn't configured (missing app URL or caller ID)." };
  }

  // Plivo's REST create-call API wants numbers without the leading '+',
  // unlike the E.164 format used in <Dial><Number> elsewhere in this app.
  const strip = (e164: string) => e164.replace(/^\+/, "");

  try {
    const response = await plivoClient.calls.create(
      strip(callerId),
      strip(phone),
      `${appUrl}/api/voice/plivo/ai-answer?callId=${call.id}`,
      {
        answerMethod: "POST",
        hangupUrl: `${appUrl}/api/voice/plivo/status?callId=${call.id}`,
        hangupMethod: "POST",
      },
    );
    await prisma.call.update({
      where: { id: call.id },
      data: { toNumber: phone, fromNumber: callerId, providerStatus: response.message },
    });
  } catch (err) {
    await prisma.call.delete({ where: { id: call.id } });
    return { error: err instanceof Error ? err.message : "Failed to place call." };
  }

  return { success: true, id: call.id };
}
