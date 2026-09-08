"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import { plivoClient } from "@/lib/plivo";
import { toE164 } from "@/lib/phone";

type ActionResult = { error: string } | { success: true; id: string };

/**
 * Places a fully autonomous AI outbound call to a lead (Phase 2) — no human
 * on the line, no browser SDK involved. REST-initiated via Plivo's
 * calls.create, answered by src/app/api/voice/plivo/ai-answer/route.ts.
 */
export async function initiateAiCall(leadId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "ai_calls", "write");

  const leadScope = can(user.role, "leads", "read");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...scopeWhere(leadScope, user, "assignedToId") },
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
