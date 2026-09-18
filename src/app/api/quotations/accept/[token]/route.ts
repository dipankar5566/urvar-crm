import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateOrderNumber } from "@/lib/id-sequences";
import { notifySystem } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";

/**
 * Phase 6 of the sales-funnel automation roadmap: lets a customer accept a
 * SENT quotation from the link in their email, with no CRM session — the
 * token itself (an unguessable Quotation.acceptToken, see src/lib/tokens.ts)
 * is the entire authorization. Lives under /api so middleware.ts's
 * session-redirect matcher (which excludes everything under /api) never
 * intercepts an unauthenticated customer hitting this route.
 *
 * GET only ever renders — it must never accept anything, since email
 * security scanners and link-prefetchers issue automatic GETs, and a
 * state-changing GET is the classic "confirm via GET link" bug class. POST
 * (from the page's own form) is the only path that can create an Order.
 *
 * Not-found and already-processed render the identical neutral page so a
 * guessed/stale token can't be used to probe a quotation's state.
 */

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th, td { text-align: left; padding: 8px; border-bottom: 1px solid #e5e5e5; font-size: 14px; }
  .total { font-weight: 600; font-size: 16px; }
  button { background: #16a34a; color: white; border: none; padding: 12px 24px; font-size: 16px; border-radius: 6px; cursor: pointer; }
  button:hover { background: #15803d; }
  .muted { color: #666; font-size: 14px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

const INVALID_HTML = pageShell(
  "Link no longer valid",
  `<h1>This link is no longer valid</h1>
<p class="muted">It may have already been used, or the quotation is no longer awaiting a response. Please contact your Urvar Natural sales representative if you have questions.</p>`,
);

const THANK_YOU_HTML = pageShell(
  "Quotation accepted",
  `<h1>Thank you</h1>
<p>Your quotation has been accepted. Our team will be in touch shortly to arrange your order.</p>`,
);

function renderConfirmPage(quotation: {
  quotationNumber: string;
  totalAmount: { toString(): string };
  items: { quantity: { toString(): string }; unitPrice: { toString(): string }; lineTotal: { toString(): string }; product: { name: string; unit: string } }[];
}): string {
  const rows = quotation.items
    .map(
      (item) => `<tr>
  <td>${escapeHtml(item.product.name)}</td>
  <td>${escapeHtml(item.quantity.toString())} ${escapeHtml(item.product.unit)}</td>
  <td>Rs ${escapeHtml(item.unitPrice.toString())}</td>
  <td>Rs ${escapeHtml(item.lineTotal.toString())}</td>
</tr>`,
    )
    .join("\n");

  return pageShell(
    `Quotation ${quotation.quotationNumber}`,
    `<h1>Quotation ${escapeHtml(quotation.quotationNumber)}</h1>
<table>
<thead><tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Line Total</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<p class="total">Total: Rs ${escapeHtml(quotation.totalAmount.toString())}</p>
<form method="POST" action="">
  <button type="submit">Accept this quotation</button>
</form>
<p class="muted">If anything here looks wrong, please contact your Urvar Natural sales representative instead of accepting.</p>`,
  );
}

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const quotation = await prisma.quotation.findUnique({
    where: { acceptToken: token },
    include: { items: { include: { product: true } }, customer: true },
  });

  if (!quotation || quotation.status !== "SENT" || !quotation.customerId) {
    return new NextResponse(INVALID_HTML, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  return new NextResponse(renderConfirmPage(quotation), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // The actual authorization + state gate — not the GET's earlier read,
  // which could be stale by the time this POST lands (render-then-submit
  // race, or a second submit after the first already succeeded).
  const existing = await prisma.quotation.findFirst({
    where: { acceptToken: token, status: "SENT" },
    include: { customer: true },
  });

  if (!existing || !existing.customerId || !existing.customer) {
    return new NextResponse(INVALID_HTML, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }

  let orderId: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const orderNumber = await generateOrderNumber();
      const [, order] = await prisma.$transaction([
        prisma.quotation.update({
          where: { id: existing.id },
          data: { status: "ACCEPTED", respondedAt: new Date() },
        }),
        prisma.order.create({
          data: {
            orderNumber,
            quotationId: existing.id,
            customerId: existing.customerId,
            leadId: existing.leadId,
            totalAmount: existing.totalAmount,
            state: existing.customer.state,
            district: existing.customer.district,
            // No real "customer" User row exists — attribute the order to
            // whoever originally sent the quote, same as every other
            // system-attributed write in this codebase (no separate
            // system-actor concept exists in the schema).
            createdById: existing.createdById,
          },
        }),
      ]);
      orderId = order.id;
      break;
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < 2) continue;
      throw err;
    }
  }

  // Deliberately no Pipeline ACCEPTED-side sync here — same open
  // ORDER_RECEIVED/WON ordering question noted at
  // src/app/(dashboard)/quotations/actions.ts:328-333 (Phase 1B), unresolved
  // for the same reason there.

  await notifySystem({
    userId: existing.createdById,
    type: "QUOTATION_RESPONSE",
    title: `Quotation ${existing.quotationNumber} accepted online`,
    body: `The customer accepted quotation ${existing.quotationNumber} online; order ${orderId ? "created" : ""} for fulfillment.`,
    relatedCustomerId: existing.customerId,
    relatedLeadId: existing.leadId ?? undefined,
  });

  await logAudit({
    userId: existing.createdById,
    action: "STATUS_CHANGE",
    entityType: "Quotation",
    entityId: existing.id,
    oldValue: { status: "SENT" },
    newValue: { status: "ACCEPTED", orderId, source: "customer_accept_link" },
  });

  return new NextResponse(THANK_YOU_HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
