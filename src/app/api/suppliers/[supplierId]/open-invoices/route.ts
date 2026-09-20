import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { outstandingOnPurchaseInvoice } from "@/lib/accounting/supplier-payments";
import { toAmountString } from "@/lib/accounting/money";

/** A supplier's open (POSTED/PARTIALLY_PAID) invoices, for payment allocation. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ supplierId: string }> },
) {
  const { supplierId } = await params;
  const user = await requireUser();
  assertCan(user.role, "purchases", "write");

  const invoices = await prisma.purchaseInvoice.findMany({
    where: { supplierId, status: { in: ["POSTED", "PARTIALLY_PAID"] } },
    select: { id: true, invoiceNumber: true, totalAmount: true },
    orderBy: { invoiceDate: "asc" },
  });

  const rows = await Promise.all(
    invoices.map(async (inv) => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      totalAmount: Number(inv.totalAmount),
      outstanding: Number(toAmountString(await outstandingOnPurchaseInvoice(inv.id))),
    })),
  );

  return NextResponse.json(rows);
}
