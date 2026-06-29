"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import { callOutcomeUpdateSchema, type CallOutcomeUpdateInput } from "@/lib/validations/call";

type ActionResult = { error: string } | { success: true; id?: string };

/** Creates a pending Call row for an in-browser Twilio call. The browser only
 * ever passes back this row's id — the actual phone number is resolved
 * server-side in the TwiML webhook, never trusted from the client. */
export async function initiateCall(
  target: { leadId: string } | { customerId: string },
): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "calls", "write");

  if ("leadId" in target) {
    const leadScope = can(user.role, "leads", "read");
    const lead = await prisma.lead.findFirst({
      where: { id: target.leadId, ...scopeWhere(leadScope, user, "assignedToId") },
      select: { id: true },
    });
    if (!lead) return { error: "Lead not found or access denied." };

    const call = await prisma.call.create({
      data: {
        leadId: target.leadId,
        userId: user.id,
        direction: "OUTBOUND",
        provider: "TWILIO",
      },
    });

    return { success: true, id: call.id };
  }

  const customerScope = can(user.role, "customers", "read");
  const customer = await prisma.customer.findFirst({
    where: { id: target.customerId, ...scopeWhere(customerScope, user, "assignedToId") },
    select: { id: true },
  });
  if (!customer) return { error: "Customer not found or access denied." };

  const call = await prisma.call.create({
    data: {
      customerId: target.customerId,
      userId: user.id,
      direction: "OUTBOUND",
      provider: "TWILIO",
    },
  });

  return { success: true, id: call.id };
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
        description: `Outbound call (Twilio) — ${data.outcome.replaceAll("_", " ")}.`,
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
