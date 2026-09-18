/**
 * Phase 5 of the sales-funnel automation roadmap (all.md): a single,
 * tightly-scoped voice-agent tool that lets the AI create-and-send a
 * quotation on its own, but ONLY for an existing customer's simple,
 * standard-priced reorder inside the Phase-4 "safe zone" — no discount, a
 * known customer in good standing, tier-correct pricing, under the value
 * cap. Everything else routes to a human, same as every other capability
 * in this file.
 *
 * Kept in its own file, separate from crm-tools.ts's other (lighter-weight,
 * read-mostly) tools, because this is the one tool whose blast radius is a
 * real, unattended customer-facing write — worth isolating for review.
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolContext, ToolResult } from "./crm-tools.js";
import { synonymTerms } from "./crm-tools.js";
import { classifyQuotationSafeZone, expectedUnitPrice } from "../../src/lib/safe-zone.js";
import type { SafeZoneProduct, SafeZoneQuotationItem } from "../../src/lib/safe-zone.js";
import { generateQuotationNumber } from "../../src/lib/id-sequences.js";
import { generateAcceptToken } from "../../src/lib/tokens.js";
import { notifyQuotationSent } from "../../src/lib/quotation-notify.js";
import { logAudit } from "../../src/lib/audit.js";
import { PIPELINE_STAGE_ORDER, STAGE_TO_STATUS } from "../../src/lib/constants/labels.js";

export const AUTO_QUOTE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "create_quotation",
    description:
      "Create and send a quotation for an EXISTING customer's simple standard reorder — a named product and quantity, nothing else. The system independently verifies pricing and eligibility server-side; you never state or promise a price yourself, only what this tool's response confirms. If it refuses, tell the caller a sales rep will prepare a formal quote instead.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Products and quantities to quote. Product name only — never a price or discount.",
          items: {
            type: "object",
            properties: {
              productName: { type: "string", description: "Product name as the customer said it." },
              quantity: { type: "number", description: "Quantity requested." },
            },
            required: ["productName", "quantity"],
          },
        },
      },
      required: ["items"],
    },
  },
};

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

export async function executeCreateQuotation(argsJson: string, ctx: ToolContext): Promise<ToolResult> {
  try {
    // Fail-closed (checked here too, not just by omitting the tool schema
    // when building CRM_TOOLS) — deliberately the opposite convention from
    // transfer_to_human's fail-open `=== "false"`. transfer_to_human
    // degrades safely to a callback and is a proven, previously-shipped
    // capability, so assuming it's on unless told otherwise is right. This
    // tool is new, writes a real customer-facing Quotation, and emails it
    // autonomously — the safe default is off unless a human explicitly
    // turned it on.
    if (process.env.AI_AUTO_QUOTE_ENABLED !== "true") {
      return { output: { error: "Auto-quoting is disabled." } };
    }

    const args = argsJson ? JSON.parse(argsJson) : {};
    const items: { productName: string; quantity: number }[] = Array.isArray(args.items) ? args.items : [];
    if (items.length === 0) {
      return { output: { created: false, error: "No items given." } };
    }

    const lead = await ctx.prisma.lead.findUnique({
      where: { id: ctx.leadId },
      select: {
        assignedToId: true,
        convertedCustomer: {
          select: {
            id: true,
            customerType: true,
            dealerTier: true,
            creditLimit: true,
            outstandingAmount: true,
          },
        },
        pipeline: { select: { id: true, stage: true } },
      },
    });

    // The safe zone is customer-only by definition (SafeZoneCustomer needs
    // dealerTier/creditLimit, which a bare Lead never has) — a lead that
    // hasn't converted yet is never eligible, so this tool is a no-op for
    // it. Never silently fall through to a rep-less quote.
    if (!lead?.convertedCustomer) {
      return {
        output: {
          created: false,
          error: "This lead has no linked customer account yet. Offer to have a rep prepare a formal quote instead.",
        },
      };
    }
    const customer = lead.convertedCustomer;

    // Resolve each product name the same way get_product_info already
    // does. 0 or >1 active match aborts the whole call — never guess.
    const resolvedItems: {
      productId: string;
      productName: string;
      quantity: number;
      gstPercent: number;
      product: SafeZoneProduct;
    }[] = [];
    for (const item of items) {
      const query = String(item.productName ?? "");
      const quantity = Number(item.quantity);
      if (!query || !Number.isFinite(quantity) || quantity <= 0) {
        return { output: { created: false, error: `Invalid item: ${JSON.stringify(item)}` } };
      }
      const searchTerms = [query, ...synonymTerms(query)].filter((t) => t.trim().length > 0);
      const matches = await ctx.prisma.product.findMany({
        where: {
          isActive: true,
          OR: searchTerms.map((term) => ({ name: { contains: term, mode: "insensitive" as const } })),
        },
        select: { id: true, name: true, mrp: true, dealerPrice: true, distributorPrice: true, gstPercent: true },
      });
      if (matches.length === 0) {
        return { output: { created: false, error: `No such product in the catalogue: "${query}". Do not guess.` } };
      }
      if (matches.length > 1) {
        return {
          output: {
            created: false,
            error: `"${query}" matches more than one product (${matches.map((m) => m.name).join(", ")}). Ask which one.`,
          },
        };
      }
      const product = matches[0];
      resolvedItems.push({
        productId: product.id,
        productName: product.name,
        quantity,
        gstPercent: Number(product.gstPercent),
        product: { mrp: product.mrp, dealerPrice: product.dealerPrice, distributorPrice: product.distributorPrice },
      });
    }

    // Price is 100% server-determined — the model never supplies one, so
    // there's no prompt-injection angle toward a discount.
    const lines = resolvedItems.map((item) => {
      const unitPrice = expectedUnitPrice(item.product, customer);
      const lineTotal = item.quantity * unitPrice;
      return { ...item, unitPrice, lineTotal };
    });
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
    const taxAmount = lines.reduce((sum, l) => sum + l.lineTotal * (l.gstPercent / 100), 0);
    const totalAmount = subtotal + taxAmount;

    // Mandatory final gate, checked here server-side — never trusted from
    // the model. Everything above was built to comply by construction
    // (zero discount everywhere), but this also catches credit limit,
    // dealer tier, and the value cap.
    const safeZoneItems: SafeZoneQuotationItem[] = lines.map((l) => ({
      productId: l.productId,
      unitPrice: l.unitPrice,
      discountPercent: 0,
    }));
    const productMap = new Map(lines.map((l) => [l.productId, l.product]));
    const classification = classifyQuotationSafeZone(
      { discountPercent: 0, discountAmount: 0, totalAmount, items: safeZoneItems },
      customer,
      productMap,
    );
    if (!classification.eligible) {
      return {
        output: {
          created: false,
          reasons: classification.reasons,
          message: "This order needs a rep's review — offer to have one prepare a formal quote.",
        },
      };
    }

    const createdById = lead.assignedToId ?? process.env.AI_CALL_FALLBACK_USER_ID;
    if (!createdById) {
      return { output: { created: false, error: "No rep available to attribute this quotation to." } };
    }

    let quotationId: string | null = null;
    let quotationNumber: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        quotationNumber = await generateQuotationNumber();
        const acceptToken = generateAcceptToken();
        const ops: unknown[] = [
          ctx.prisma.quotation.create({
            data: {
              quotationNumber,
              acceptToken,
              leadId: ctx.leadId,
              customerId: customer.id,
              createdById,
              status: "SENT",
              sentAt: new Date(),
              subtotal,
              discountPercent: 0,
              discountAmount: 0,
              freightAmount: 0,
              taxAmount,
              totalAmount,
              items: {
                create: lines.map((l) => ({
                  productId: l.productId,
                  quantity: l.quantity,
                  unitPrice: l.unitPrice,
                  discountPercent: 0,
                  lineTotal: l.lineTotal,
                })),
              },
            },
          }),
        ];

        // Mirrors actions.ts:328-360's Phase-1B SENT-side pipeline sync
        // verbatim — unavoidably duplicated here since this file can't
        // import a "use server" action across the voice-agent/Next process
        // boundary. Keep in sync with that block if it ever changes.
        if (lead.pipeline) {
          const currentIdx = PIPELINE_STAGE_ORDER.indexOf(
            lead.pipeline.stage as (typeof PIPELINE_STAGE_ORDER)[number],
          );
          const targetIdx = PIPELINE_STAGE_ORDER.indexOf("QUOTATION_SENT");
          if (currentIdx >= 0 && currentIdx < targetIdx) {
            ops.push(
              ctx.prisma.pipeline.update({
                where: { leadId: ctx.leadId },
                data: { stage: "QUOTATION_SENT", enteredStageAt: new Date() },
              }),
              ctx.prisma.pipelineStageHistory.create({
                data: {
                  pipelineId: lead.pipeline.id,
                  fromStage: lead.pipeline.stage,
                  toStage: "QUOTATION_SENT",
                  movedById: createdById,
                },
              }),
              ctx.prisma.lead.update({
                where: { id: ctx.leadId },
                data: { status: STAGE_TO_STATUS["QUOTATION_SENT"] as never },
              }),
            );
          }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [quotation] = (await ctx.prisma.$transaction(ops as any[])) as [{ id: string }];
        quotationId = quotation.id;
        break;
      } catch (err) {
        if (isUniqueConstraintError(err) && attempt < 2) continue;
        throw err;
      }
    }
    if (!quotationId || !quotationNumber) {
      return { output: { created: false, error: "Could not create the quotation right now." } };
    }

    await ctx.prisma.leadActivity.create({
      data: {
        leadId: ctx.leadId,
        type: "QUOTATION_CREATED",
        description: `Quotation ${quotationNumber} auto-created and sent by the AI voice agent (safe zone).`,
        createdById,
      },
    });
    await ctx.prisma.leadActivity.create({
      data: {
        leadId: ctx.leadId,
        type: "QUOTATION_SENT",
        description: `Quotation ${quotationNumber} auto-created and sent by the AI voice agent (safe zone).`,
        createdById,
      },
    });

    await logAudit({
      userId: createdById,
      action: "CREATE",
      entityType: "Quotation",
      entityId: quotationId,
      newValue: { quotationNumber, totalAmount, source: "ai_voice_agent", leadId: ctx.leadId },
    });

    try {
      const actor = await ctx.prisma.user.findUnique({ where: { id: createdById }, select: { email: true } });
      await notifyQuotationSent(quotationId, createdById, actor?.email);
    } catch (err) {
      console.error(`[tool ${ctx.callId}] create_quotation: notifyQuotationSent failed:`, err);
    }

    return {
      output: {
        created: true,
        quotationNumber,
        totalAmount,
        message: `Quotation ${quotationNumber} created and sent for Rs ${totalAmount.toFixed(2)}.`,
      },
    };
  } catch (err) {
    console.error(`[tool ${ctx.callId}] create_quotation failed:`, err);
    return { output: { created: false, error: "Could not create the quotation right now. A rep will follow up." } };
  }
}
