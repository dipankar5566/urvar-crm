import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { assertCan, can, scopedWhere } from "@/lib/permissions";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { NewInvoiceForm } from "./new-invoice-form";

export default async function NewInvoicePage({
  searchParams,
}: {
  searchParams: Promise<{ orderId?: string }>;
}) {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");
  const { orderId } = await searchParams;

  if (!orderId) {
    return (
      <div className="space-y-6">
        <PageHeader title="Raise Invoice" />
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Open a quotation with an order attached and use its &quot;Raise Invoice&quot; button —
            there is no free-standing invoice form yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  const orderScope = can(user.role, "quotations", "read");
  const order = await prisma.order.findFirst({
    where: scopedWhere(orderScope, user, "createdById", { id: orderId }),
    include: {
      customer: { select: { name: true, state: true, gstNumber: true } },
      items: { orderBy: { lineNumber: "asc" } },
      quotation: { select: { quotationNumber: true, freightAmount: true, discountAmount: true } },
      _count: { select: { salesInvoices: { where: { status: { not: "CANCELLED" } } } } },
    },
  });
  if (!order) notFound();

  // Freight and an overall discount are quoted at quotation level, not per
  // line, so they don't travel with the order lines. Pre-fill them on the
  // FIRST invoice only (the rep can still edit), so invoicing a quote bills
  // what was quoted — QT-2026-0004 quoted ₹500 freight and the form used to
  // start at ₹0. Later partial invoices start at zero to avoid billing twice.
  const isFirstInvoice = order._count.salesInvoices === 0;
  const defaults = {
    freightAmount: isFirstInvoice ? Number(order.quotation?.freightAmount ?? 0) : 0,
    discountAmount: isFirstInvoice ? Number(order.quotation?.discountAmount ?? 0) : 0,
    fromQuotation: isFirstInvoice ? (order.quotation?.quotationNumber ?? null) : null,
  };

  const remaining = order.items.map((item) => ({
    id: item.id,
    description: item.description,
    unit: "",
    quantity: Number(item.quantity),
    quantityInvoiced: Number(item.quantityInvoiced),
    remaining: Number(item.quantity) - Number(item.quantityInvoiced),
    unitPrice: Number(item.unitPrice),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Raise Invoice — ${order.orderNumber}`}
        subtitle={`${order.customer.name} · ${order.customer.state}`}
      />
      <NewInvoiceForm orderId={order.id} items={remaining} defaults={defaults} />
    </div>
  );
}
