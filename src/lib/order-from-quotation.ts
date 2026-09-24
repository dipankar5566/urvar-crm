import type { Prisma } from "@/generated/prisma/client";
import { div, money, round } from "@/lib/accounting/money";

type QuotationLine = {
  productId: string;
  description: string | null;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  product?: { name: string } | null;
};

/**
 * The OrderItem rows for an order accepted from a quotation — one per
 * quotation line, in the quotation's order.
 *
 * Both acceptance paths (`updateQuotationStatus` for a rep, and the customer
 * accept link) must create these in the same transaction as the Order.
 * Invoicing is line-based (`createInvoiceFromOrder`), so an order created
 * with only a `totalAmount` can never be invoiced — and the Raise Invoice
 * form, finding zero lines left to bill, reported it as "already fully
 * invoiced". That happened in production to ORD-2026-0137/0138 before this
 * helper existed; `scripts/backfill-order-items.ts` repairs such orders.
 *
 * OrderItem has no discount column, so a line discount is folded into the
 * unit price (lineTotal / quantity, rounded to paise) to keep the invoice at
 * the price that was quoted. With no line discount — the common case — the
 * quoted unit price is copied unchanged. A quotation-level discount and
 * freight live on the Quotation, not its lines; the Raise Invoice form
 * pre-fills those for the first invoice.
 */
export function orderItemsFromQuotation(
  lines: QuotationLine[],
): Prisma.OrderItemCreateWithoutOrderInput[] {
  return lines.map((line, i) => {
    const quantity = money(line.quantity);
    const unitPrice =
      money(line.discountPercent).isZero() || quantity.isZero()
        ? money(line.unitPrice)
        : round(div(line.lineTotal, quantity));
    return {
      product: { connect: { id: line.productId } },
      description: line.description?.trim() || line.product?.name || `Line ${i + 1}`,
      quantity,
      unitPrice,
      lineTotal: money(line.lineTotal),
      lineNumber: i + 1,
    };
  });
}
