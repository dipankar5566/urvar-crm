"use server";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopeWhere } from "@/lib/permissions";
import { dialAiCall } from "@/lib/ai-call-dialer";

type ActionResult = { error: string } | { success: true; id: string };

/**
 * Places a fully autonomous AI outbound call to a lead (Phase 2) — no human
 * on the line, no browser SDK involved. REST-initiated via Plivo's
 * calls.create, answered by src/app/api/voice/plivo/ai-answer/route.ts.
 *
 * The actual dialing logic lives in ai-call-dialer.ts's dialAiCall(),
 * shared with the Phase 7 backlog cron sweep (ai-backlog-cron.ts), which
 * has no session to authorize through. This action still does its own
 * scoped existence/authorization check first — the human-facing entry
 * point is the one place that needs it.
 */
export async function initiateAiCall(leadId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "ai_calls", "write");

  const leadScope = can(user.role, "leads", "read");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, deletedAt: null, ...scopeWhere(leadScope, user, "assignedToId") },
    select: { id: true },
  });
  if (!lead) return { error: "Lead not found or access denied." };

  return dialAiCall(leadId);
}
