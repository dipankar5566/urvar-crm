/**
 * Phase 2 AI_AUTONOMOUS tool set — thin wrappers over the shared Prisma
 * client (imported the same way voice-agent/server.ts already does), each
 * exposed to OpenAI's tool-calling as a `{type:"function", function:{...}}`
 * definition. `executeCrmTool` dispatches by name and returns both the
 * result to feed back to the model and an optional control signal telling
 * the agent loop in server.ts to stop (end_call) or hand off (transfer_to_human).
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { ProductCategory } from "../../src/generated/prisma/enums.js";
import { plivoClient, getOrCreateEndpoint } from "../../src/lib/plivo.js";

export type ToolContext = {
  prisma: PrismaClient;
  leadId: string;
  callId: string;
  providerCallSid: string | null;
  originUrl: string;
};

export type ToolResult = {
  output: Record<string, unknown>;
  /** Tells the agent loop in server.ts to stop after this turn. */
  controlSignal?: "end_call" | "transfer_to_human";
};

export const CRM_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_lead_context",
      description: "Get full details about the lead being called: name, status, interested products, expected quantity, crop interest, remarks, and location.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product_info",
      description: "Search Urvar's product catalog by name or category keyword (e.g. 'vermicompost', 'bio-fertilizer').",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Product name or category keyword to search for." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_quotation_status",
      description: "Check the status of the most recent quotation sent to this lead, if any.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_follow_up",
      description: "Schedule a human follow-up call at the customer's request, mid-conversation (e.g. they asked to be called back at a specific time). Does not end the call.",
      parameters: {
        type: "object",
        properties: {
          dueInHours: { type: "number", description: "Hours from now the follow-up should happen." },
          notes: { type: "string", description: "What the follow-up should be about." },
        },
        required: ["dueInHours", "notes"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_do_not_call",
      description: "Mark this lead as do-not-call because they explicitly asked not to be contacted again. Use only on an explicit, unambiguous request.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "Why the lead asked not to be called again." } },
        required: ["reason"],
      },
    },
  },
  // Re-enabled 2026-09-11 after being withheld since 2026-09-10, when the
  // agent told a lead "connecting you to our representative now, stay on the
  // line" and nothing happened — `transferredToUserId` stayed null and the
  // lead was left holding. That withdrawal note set two conditions for
  // bringing it back, and both are now addressed rather than waived:
  //
  //   1. "the route has been verified end-to-end (it has no logging today,
  //      so the earlier failure could not be traced)" — the route now logs
  //      every hit, decision and failure reason.
  //   2. "once a rep is actually logged in to receive calls" — cannot be
  //      proven from here, so the failure is made safe instead: the route
  //      already falls back to a spoken apology plus a HIGH-priority
  //      FollowUp when the rep does not answer inside 30s, and the prompt
  //      below forbids promising a connection before one exists.
  //
  // `AI_TRANSFER_ENABLED=false` withdraws it again without a deploy.
  {
    type: "function",
    function: {
      name: "transfer_to_human",
      description:
        "Connect this call to the lead's sales rep right now. Use ONLY on a clear buying signal: they want to place an order, asked for a price list or dealership, named a quantity they intend to buy, or asked to speak to a person. If it returns an error, fall back to schedule_follow_up.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "The buying signal that justified the transfer, in a few words.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_call",
      description: "End the call now and record the outcome. Always call this once the conversation has naturally concluded.",
      parameters: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            enum: [
              "CONNECTED",
              "NOT_REACHABLE",
              "INTERESTED",
              "FOLLOW_UP_REQUIRED",
              "QUOTATION_REQUESTED",
              "WRONG_NUMBER",
            ],
            description: "Best-matching outcome for this call.",
          },
          farewell: { type: "string", description: "A short closing line to speak before hanging up." },
        },
        required: ["outcome", "farewell"],
      },
    },
  },
];

/**
 * What people actually say, mapped to the English words the catalogue is
 * stored under. Translations only — nothing here asserts anything about a
 * product, so it is safe to extend without agronomic review.
 */
const PRODUCT_SYNONYMS: Record<string, string[]> = {
  // Bengali
  "কেঁচো": ["vermicompost"],
  "কেচো": ["vermicompost"],
  "ভার্মি": ["vermicompost"],
  "জৈব": ["organic"],
  "জৈব সার": ["organic"],
  "গোবর": ["dung", "manure"],
  "হিউমিক": ["humic"],
  "জিঙ্ক": ["zinc", "micronutrient"],
  "বোরন": ["boron", "micronutrient"],
  "সার": ["fertilizer", "compost"],
  // Hindi
  "वर्मीकम्पोस्ट": ["vermicompost"],
  "केंचुआ": ["vermicompost"],
  "जैविक": ["organic"],
  "गोबर": ["dung", "manure"],
  "ह्यूमिक": ["humic"],
  "जिंक": ["zinc", "micronutrient"],
  "बोरॉन": ["boron", "micronutrient"],
  "खाद": ["fertilizer", "compost"],
};

function synonymTerms(query: string): string[] {
  const lower = query.toLowerCase();
  const terms = new Set<string>();
  for (const [word, mapped] of Object.entries(PRODUCT_SYNONYMS)) {
    if (query.includes(word) || lower.includes(word.toLowerCase())) {
      for (const term of mapped) terms.add(term);
    }
  }
  return [...terms];
}

export async function executeCrmTool(
  name: string,
  argsJson: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const args = argsJson ? JSON.parse(argsJson) : {};

  switch (name) {
    case "get_lead_context": {
      const lead = await ctx.prisma.lead.findUnique({
        where: { id: ctx.leadId },
        select: {
          name: true,
          status: true,
          customerType: true,
          interestedProducts: true,
          expectedQuantity: true,
          cropInterest: true,
          remarks: true,
          state: true,
          district: true,
        },
      });
      return { output: lead ? { ...lead } : { error: "Lead not found" } };
    }

    case "get_product_info": {
      const query = String(args.query ?? "");
      // Product names are stored in English, but a farmer asks for "কেঁচো সার"
      // or "जैविक खाद". A substring match on the raw query would find nothing
      // and the agent would tell them we don't sell it. These are translations
      // of what people actually say, not claims about the products.
      const searchTerms = [query, ...synonymTerms(query)].filter((t) => t.trim().length > 0);
      // Prisma validates enum values at the DB-client level — passing an
      // arbitrary uppercased string here throws PrismaClientValidationError
      // if it isn't one of the real ProductCategory values (confirmed live:
      // the model searched "general organic fertilizer", not a real
      // category, and the whole tool call failed). Only add the category
      // branch when the query actually matches a known category.
      const categoryGuess = query.toUpperCase().replace(/[\s-]+/g, "_");
      const matchedCategory = (Object.values(ProductCategory) as string[]).includes(categoryGuess)
        ? (categoryGuess as ProductCategory)
        : null;

      const products = await ctx.prisma.product.findMany({
        where: {
          isActive: true,
          OR: [
            ...searchTerms.map((term) => ({
              name: { contains: term, mode: "insensitive" as const },
            })),
            ...(matchedCategory ? [{ category: matchedCategory }] : []),
          ],
        },
        select: { name: true, category: true, unit: true, packSize: true, mrp: true, description: true },
        take: 5,
      });

      // "We don't stock that" and "I can't see a price" are different answers
      // and the caller deserves the right one. Without this the model got an
      // empty list either way and had to guess which it was.
      if (products.length === 0) {
        console.log(`[tool ${ctx.callId}] get_product_info: no catalogue match for "${query}"`);
        return {
          output: {
            products: [],
            notInCatalogue: true,
            message:
              "No such product in the Urvar catalogue. Do not invent one. Say you will check and have someone confirm, and offer a callback.",
          },
        };
      }

      // Never hand the model a price it shouldn't say. An unset MRP is 0 in
      // the DB, and on 2026-09-10 the agent dutifully told a customer "the
      // system shows MRP 0" for Enriched Vermicompost. Dropping the field
      // entirely leaves nothing to read out; `priceOnRequest` tells the
      // model to offer a quotation instead (see the system prompt rule).
      const safe = products.map(({ mrp, ...rest }) => {
        const value = mrp == null ? 0 : Number(mrp);
        return value > 0 ? { ...rest, mrp: value } : { ...rest, priceOnRequest: true };
      });
      return { output: { products: safe } };
    }

    case "check_quotation_status": {
      const quotation = await ctx.prisma.quotation.findFirst({
        where: { leadId: ctx.leadId },
        orderBy: { createdAt: "desc" },
        select: { quotationNumber: true, status: true, totalAmount: true, validUntil: true },
      });
      return { output: quotation ? { ...quotation } : { message: "No quotation found for this lead" } };
    }

    case "schedule_follow_up": {
      const lead = await ctx.prisma.lead.findUnique({
        where: { id: ctx.leadId },
        select: { assignedToId: true },
      });
      const assignedToId = lead?.assignedToId ?? process.env.AI_CALL_FALLBACK_USER_ID;
      if (!assignedToId) return { output: { error: "No rep available to assign the follow-up to" } };

      const dueInHours = Number(args.dueInHours) || 24;
      await ctx.prisma.followUp.create({
        data: {
          leadId: ctx.leadId,
          assignedToId,
          dueAt: new Date(Date.now() + dueInHours * 60 * 60 * 1000),
          notes: String(args.notes ?? ""),
        },
      });
      return { output: { scheduled: true } };
    }

    case "mark_do_not_call": {
      await ctx.prisma.lead.update({
        where: { id: ctx.leadId },
        data: { doNotCall: true, doNotCallReason: String(args.reason ?? "") },
      });
      return { output: { marked: true }, controlSignal: "end_call" };
    }

    case "transfer_to_human": {
      // Kill switch, so the capability can be withdrawn without a deploy the
      // way it was last time. The model is told to fall back to a callback.
      if (process.env.AI_TRANSFER_ENABLED === "false") {
        console.log(`[tool ${ctx.callId}] transfer_to_human refused: disabled by AI_TRANSFER_ENABLED`);
        return { output: { error: "Live transfer is unavailable. Schedule a follow-up instead." } };
      }

      const lead = await ctx.prisma.lead.findUnique({
        where: { id: ctx.leadId },
        select: { assignedToId: true },
      });
      const repId = lead?.assignedToId ?? process.env.AI_CALL_FALLBACK_USER_ID;
      if (!repId || !ctx.providerCallSid) {
        console.log(
          `[tool ${ctx.callId}] transfer_to_human refused: repId=${repId ?? "none"} providerCallSid=${ctx.providerCallSid ?? "none"}`,
        );
        return { output: { error: "No rep available to transfer to. Schedule a follow-up instead." } };
      }
      console.log(
        `[tool ${ctx.callId}] transfer_to_human -> rep=${repId} reason="${String(args.reason ?? "").slice(0, 60)}"`,
      );

      // Ensures the rep has a SIP Endpoint before the transfer XML tries to
      // dial it — same reuse as the existing human-initiated call flow.
      await getOrCreateEndpoint(repId);
      // The plivo package's own .d.ts marks alegMethod/blegUrl/blegMethod as
      // required even though its JSDoc (and Plivo's REST API) only requires
      // blegUrl/blegMethod when legs is "bleg"/"both" — same doc-vs-types
      // gap already found with Response.addStream. blegUrl left empty since
      // legs is "aleg" only.
      await plivoClient.calls.transfer(ctx.providerCallSid, {
        legs: "aleg",
        alegUrl: `${ctx.originUrl}/api/voice/plivo/transfer?callId=${ctx.callId}&repId=${repId}`,
        alegMethod: "POST",
        blegUrl: "",
        blegMethod: "POST",
      });

      return { output: { transferring: true }, controlSignal: "transfer_to_human" };
    }

    case "end_call": {
      await recordCallOutcome(ctx.prisma, {
        callId: ctx.callId,
        leadId: ctx.leadId,
        outcome: String(args.outcome ?? "CONNECTED"),
      });

      return { output: { ended: true, farewell: String(args.farewell ?? "") }, controlSignal: "end_call" };
    }

    default:
      return { output: { error: `Unknown tool: ${name}` } };
  }
}

/**
 * Records how an AI call ended: the outcome on the Call row, the wrap-up
 * FollowUp that hands the lead back to a human, and the lead's activity
 * entry.
 *
 * Shared with server.ts's finalizeSession, which applies a default outcome
 * when `end_call` never ran — the model's compliance is unreliable on both
 * providers, and a lead who hangs up first never gives it the chance. Before
 * that guard, 9 of 20 real AI conversations landed in the CRM with a
 * transcript and summary but no outcome and nothing for a rep to act on.
 */
export async function recordCallOutcome(
  prisma: PrismaClient,
  params: {
    callId: string;
    leadId: string;
    outcome: string;
    /** False after a transfer: the rep who took the call owns the next step
     * and logs it themselves, so a wrap-up task would just be noise. */
    createFollowUp?: boolean;
    /** Set by the server-side guard rather than the model's own end_call. */
    auto?: boolean;
  },
): Promise<void> {
  const { callId, leadId, outcome, createFollowUp = true, auto = false } = params;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { assignedToId: true },
  });
  const assignedToId = lead?.assignedToId ?? process.env.AI_CALL_FALLBACK_USER_ID ?? null;

  // Only create the default wrap-up FollowUp if schedule_follow_up
  // wasn't already explicitly called this session — avoids a duplicate
  // task when the AI already scheduled one mid-call. `call: null` is
  // required, not just leadId+recency: Call.followUpId is @unique, so a
  // FollowUp already claimed by an earlier call to the same lead (e.g. a
  // retry within the hour) would otherwise be picked up here too and
  // blow up this update with a P2002 unique-constraint error (confirmed
  // live in logs/voice-agent-error-16.log).
  let followUpId: string | null = null;
  if (createFollowUp) {
    const existingFollowUp = await prisma.followUp.findFirst({
      where: {
        leadId,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        call: null,
      },
      orderBy: { createdAt: "desc" },
    });

    followUpId = existingFollowUp?.id ?? null;
    if (!followUpId && assignedToId) {
      const followUp = await prisma.followUp.create({
        data: {
          leadId,
          assignedToId,
          dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          notes: `AI call outcome: ${outcome}`,
        },
      });
      followUpId = followUp.id;
    }
  }

  await prisma.call.update({
    where: { id: callId },
    data: {
      outcome: outcome as never,
      // Left untouched when no wrap-up task was wanted, rather than nulled —
      // this must never clear a link an earlier write established.
      ...(createFollowUp ? { followUpId } : {}),
    },
  });

  // A valid createdById is required (LeadActivity has no fallback
  // "system" user) — skip the activity log entirely rather than write
  // an invalid FK if there's truly no rep and no AI_CALL_FALLBACK_USER_ID.
  if (assignedToId) {
    await prisma.leadActivity.create({
      data: {
        leadId,
        type: "CALL_LOGGED",
        description: `AI call — ${outcome.replaceAll("_", " ")}.`,
        createdById: assignedToId,
        metadata: { callId, aiHandled: true, autoRecorded: auto },
      },
    });
  }
}
