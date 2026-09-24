import { describe, it, expect } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { orderItemsFromQuotation } from "@/lib/order-from-quotation";
import { createInvoiceFromOrder } from "@/lib/accounting/invoicing";
import { toAmountString } from "@/lib/accounting/money";
import {
  withRollback, testUserId, openPeriodDate, ensureVerifiedTaxRate, testProduct, testCustomer,
} from "./helpers/db";

const D = (v: string | number) => new Prisma.Decimal(v);
const line = (o: Partial<Parameters<typeof orderItemsFromQuotation>[0][number]> = {}) => ({
  productId: "prod-1",
  description: null,
  quantity: D(20),
  unitPrice: D(187.5),
  discountPercent: D(0),
  lineTotal: D(3750),
  product: { name: "Enriched Vermicompost" },
  ...o,
});

describe("orderItemsFromQuotation()", () => {
  it("copies each quotation line in order, numbering from 1", () => {
    const items = orderItemsFromQuotation([line(), line({ productId: "prod-2", quantity: D(2), unitPrice: D(50), lineTotal: D(100) })]);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.lineNumber)).toEqual([1, 2]);
    expect(items[1].product).toEqual({ connect: { id: "prod-2" } });
  });

  it("copies the unit price unchanged when the line has no discount (the QT-2026-0004 case)", () => {
    const [item] = orderItemsFromQuotation([line()]);
    expect(String(item.quantity)).toBe("20");
    expect(String(item.unitPrice)).toBe("187.5");
    expect(String(item.lineTotal)).toBe("3750");
  });

  it("uses the product name when the quotation line has no description", () => {
    expect(orderItemsFromQuotation([line()])[0].description).toBe("Enriched Vermicompost");
    expect(orderItemsFromQuotation([line({ description: "  Custom 50kg bag  " })])[0].description).toBe("Custom 50kg bag");
    expect(orderItemsFromQuotation([line({ product: null })])[0].description).toBe("Line 1");
  });

  it("folds a line discount into the unit price so the invoice bills what was quoted", () => {
    // 10 x 100 at 15% off = 850
    const [item] = orderItemsFromQuotation([
      line({ quantity: D(10), unitPrice: D(100), discountPercent: D(15), lineTotal: D(850) }),
    ]);
    expect(toAmountString(item.unitPrice as Prisma.Decimal)).toBe("85.00");
  });

  it("returns no lines for a quotation with none", () => {
    expect(orderItemsFromQuotation([])).toEqual([]);
  });
});

describe("an order built from quotation lines is invoiceable", () => {
  it("invoices every copied line — the regression behind QT-2026-0004", async () => {
    await withRollback(async (tx) => {
      const userId = await testUserId(tx);
      const date = await openPeriodDate(tx);
      await ensureVerifiedTaxRate(tx, "3101", 5);
      const customer = await testCustomer(tx);
      const product = await testProduct(tx, { hsnCode: "3101" });

      const order = await tx.order.create({
        data: {
          orderNumber: `TEST-ORD-QT-${Date.now()}`,
          customerId: customer.id,
          totalAmount: "3750",
          state: customer.state,
          district: customer.district,
          createdById: userId,
          items: { create: orderItemsFromQuotation([line({ productId: product.id })]) },
        },
        include: { items: true },
      });
      expect(order.items).toHaveLength(1);

      const invoice = await createInvoiceFromOrder({ orderId: order.id, invoiceDate: date, createdById: userId }, tx);
      // 20 x 187.50 = 3,750 + 5% GST = 3,937.50, rounded to the rupee by the
      // invoice engine (the 0.50 goes to the ROUND_OFF account).
      expect(invoice.totalAmount).toBe("3938.00");

      const item = await tx.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
      expect(toAmountString(item.quantityInvoiced)).toBe("20.00");
    });
  });
});
