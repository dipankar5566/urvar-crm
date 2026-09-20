import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan, can, scopedWhere } from "@/lib/permissions";
import { outstandingOnInvoice } from "@/lib/accounting/receipts";
import { toAmountString } from "@/lib/accounting/money";

/**
 * A customer's open (non-fully-paid, non-cancelled) invoices, for the
 * receipt-allocation form. Scoped the same way the customer detail page is:
 * a rep can only pull invoices for a customer they can already see.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const { customerId } = await params;
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  const customerScope = can(user.role, "customers", "read");
  const customer = await prisma.customer.findFirst({
    where: scopedWhere(customerScope, user, "assignedToId", { id: customerId, deletedAt: null }),
  });
  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const invoices = await prisma.salesInvoice.findMany({
    where: {
      customerId,
      status: { in: ["POSTED", "PARTIALLY_PAID"] },
    },
    select: { id: true, invoiceNumber: true, totalAmount: true },
    orderBy: { invoiceDate: "asc" },
  });

  const rows = await Promise.all(
    invoices.map(async (inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      totalAmount: Number(inv.totalAmount),
      outstanding: Number(toAmountString(await outstandingOnInvoice(inv.id))),
    })),
  );

  return NextResponse.json(rows);
}
