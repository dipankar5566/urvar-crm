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
  {
    type: "function",
    function: {
      name: "transfer_to_human",
      description: "Transfer the live call to a human rep right now — use when the lead explicitly asks for a human, or the conversation is stuck/escalated beyond what you can resolve.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "Why you're transferring." } },
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
      const products = await ctx.prisma.product.findMany({
        where: {
          isActive: true,
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { category: { equals: query.toUpperCase() as never } },
          ],
        },
        select: { name: true, category: true, unit: true, packSize: true, mrp: true, description: true },
        take: 5,
      });
      return { output: { products } };
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
      const lead = await ctx.prisma.lead.findUnique({
        where: { id: ctx.leadId },
        select: { assignedToId: true },
      });
      const repId = lead?.assignedToId ?? process.env.AI_CALL_FALLBACK_USER_ID;
      if (!repId || !ctx.providerCallSid) {
        return { output: { error: "No rep or call UUID available to transfer to" } };
      }

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
      const outcome = String(args.outcome ?? "CONNECTED");
      const lead = await ctx.prisma.lead.findUnique({
        where: { id: ctx.leadId },
        select: { assignedToId: true },
      });
      const assignedToId = lead?.assignedToId ?? process.env.AI_CALL_FALLBACK_USER_ID ?? null;

      // Only create the default wrap-up FollowUp if schedule_follow_up
      // wasn't already explicitly called this session — avoids a duplicate
      // task when the AI already scheduled one mid-call.
      const existingFollowUp = await ctx.prisma.followUp.findFirst({
        where: { leadId: ctx.leadId, createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
        orderBy: { createdAt: "desc" },
      });

      let followUpId: string | null = existingFollowUp?.id ?? null;
      if (!followUpId && assignedToId) {
        const followUp = await ctx.prisma.followUp.create({
          data: {
            leadId: ctx.leadId,
            assignedToId,
            dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            notes: `AI call outcome: ${outcome}`,
          },
        });
        followUpId = followUp.id;
      }

      await ctx.prisma.call.update({
        where: { id: ctx.callId },
        data: {
          outcome: outcome as never,
          followUpId,
        },
      });

      // A valid createdById is required (LeadActivity has no fallback
      // "system" user) — skip the activity log entirely rather than write
      // an invalid FK if there's truly no rep and no AI_CALL_FALLBACK_USER_ID.
      if (assignedToId) {
        await ctx.prisma.leadActivity.create({
          data: {
            leadId: ctx.leadId,
            type: "CALL_LOGGED",
            description: `AI call — ${outcome.replaceAll("_", " ")}.`,
            createdById: assignedToId,
            metadata: { callId: ctx.callId, aiHandled: true },
          },
        });
      }

      return { output: { ended: true, farewell: String(args.farewell ?? "") }, controlSignal: "end_call" };
    }

    default:
      return { output: { error: `Unknown tool: ${name}` } };
  }
}
