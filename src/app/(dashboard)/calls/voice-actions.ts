"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import { callOutcomeUpdateSchema, type CallOutcomeUpdateInput } from "@/lib/validations/call";
import { issueAssistToken } from "@/lib/voice-agent-token";

type ActionResult = { error: string } | { success: true; id?: string };

/** Creates a pending Call row for an in-browser Plivo call. The browser only
 * ever passes back this row's id — the actual phone number is resolved
 * server-side in the answer_url webhook, never trusted from the client.
 *
 * `enableAiAssist` opts this call into the AI Voice Agent's passive
 * call-assist overlay (live transcript + suggestions, no AI on the line —
 * a human still dials and talks). Default off; gated by the `ai_calls`
 * module separately from plain `calls` write access. */
export async function initiateCall(
  target: { leadId: string } | { customerId: string },
  enableAiAssist = false,
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "calls", "write");
  if (enableAiAssist) assertCan(user.role, "ai_calls", "read");

  const callMode = enableAiAssist ? "AI_ASSISTED" : "HUMAN";

  if ("leadId" in target) {
    const leadScope = can(user.role, "leads", "read");
    const lead = await prisma.lead.findFirst({
      where: { id: target.leadId, deletedAt: null, ...scopeWhere(leadScope, user, "assignedToId") },
      select: { id: true },
    });
    if (!lead) return { error: "Lead not found or access denied." };

    const call = await prisma.call.create({
      data: {
        leadId: target.leadId,
        userId: user.id,
        direction: "OUTBOUND",
        provider: "PLIVO",
        callMode,
      },
    });

    return { success: true, id: call.id };
  }

  const customerScope = can(user.role, "customers", "read");
  const customer = await prisma.customer.findFirst({
    where: { id: target.customerId, deletedAt: null, ...scopeWhere(customerScope, user, "assignedToId") },
    select: { id: true },
  });
  if (!customer) return { error: "Customer not found or access denied." };

  const call = await prisma.call.create({
    data: {
      customerId: target.customerId,
      userId: user.id,
      direction: "OUTBOUND",
      provider: "PLIVO",
      callMode,
    },
  });

  return { success: true, id: call.id };
}

/**
 * Issues a short-lived signed token authorizing the browser's live-assist
 * WebSocket connection for this call (see `src/lib/voice-agent-token.ts`).
 * Scoped to calls the requesting user can actually see, same as any other
 * `calls` read — an AI_ASSISTED call belonging to someone else's territory
 * shouldn't be listenable just because the callId is known.
 */
export async function getAssistToken(
  callId: string,
): Promise<{ error: string } | { success: true; token: string }> {
  const user = await requireUser();
  const scope = assertCan(user.role, "ai_calls", "read");

  const call = await prisma.call.findFirst({
    where: { id: callId, callMode: "AI_ASSISTED", ...scopeWhere(scope, user, "userId") },
    select: { id: true },
  });
  if (!call) return { error: "Call not found or access denied." };

  return { success: true, token: issueAssistToken(callId, user.id) };
}

/** Called after hangup once the rep picks the final outcome/notes. */
export async function completeVoiceCall(
  callId: string,
  input: CallOutcomeUpdateInput,
): Promise<ActionResult> {
  const user = await requireUser();
  const scope = assertCan(user.role, "calls", "write");
  const parsed = callOutcomeUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;

  const existing = await prisma.call.findFirst({
    where: { id: callId, ...scopeWhere(scope, user, "userId") },
  });
  if (!existing) return { error: "Call not found or access denied." };

  await prisma.call.update({
    where: { id: callId },
    data: { outcome: data.outcome as never, notes: data.notes },
  });

  if (existing.leadId) {
    await prisma.leadActivity.create({
      data: {
        leadId: existing.leadId,
        type: "CALL_LOGGED",
        description: `Outbound call (Plivo) — ${data.outcome.replaceAll("_", " ")}.`,
        createdById: user.id,
      },
    });
    revalidatePath(`/leads/${existing.leadId}`);
  } else if (existing.customerId) {
    revalidatePath(`/customers/${existing.customerId}`);
  }

  revalidatePath("/calls");
  revalidatePath("/dashboard");
  return { success: true };
}
