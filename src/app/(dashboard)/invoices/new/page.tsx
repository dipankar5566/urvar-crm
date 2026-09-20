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
    },
  });
  if (!order) notFound();

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
      <NewInvoiceForm orderId={order.id} items={remaining} />
    </div>
  );
}
