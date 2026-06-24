import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { QuotationForm } from "../../quotation-form";

export default async function EditQuotationPage({
  params,
}: {
  params: Promise<{ quotationId: string }>;
}) {
  const { quotationId } = await params;
  const user = await requireUser();
  const scope = can(user.role, "quotations", "write");
  if (scope === "none") notFound();

  const quotation = await prisma.quotation.findFirst({
    where: { id: quotationId, ...scopeWhere(scope, user, "createdById") },
    include: { items: true },
  });
  if (!quotation) notFound();
  if (quotation.status !== "DRAFT") notFound();

  const customerScope = can(user.role, "customers", "read");
  const leadScope = can(user.role, "leads", "read");

  const [customers, leads, products] = await Promise.all([
    prisma.customer.findMany({
      where: scopeWhere(customerScope, user, "assignedToId"),
      select: { id: true, name: true, customerNumber: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.lead.findMany({
      where: { ...scopeWhere(leadScope, user, "assignedToId"), convertedAt: null },
      select: { id: true, name: true, leadNumber: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.product.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        sku: true,
        unit: true,
        mrp: true,
        dealerPrice: true,
        distributorPrice: true,
        gstPercent: true,
      },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Edit Quotation</h1>
        <p className="text-sm text-muted-foreground">{quotation.quotationNumber}</p>
      </div>
      <QuotationForm
        quotationId={quotation.id}
        customers={customers.map((c) => ({ id: c.id, label: `${c.name} (${c.customerNumber})` }))}
        leads={leads.map((l) => ({ id: l.id, label: `${l.name} (${l.leadNumber})` }))}
        products={products.map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          unit: p.unit,
          mrp: p.mrp.toString(),
          dealerPrice: p.dealerPrice?.toString() ?? null,
          distributorPrice: p.distributorPrice?.toString() ?? null,
          gstPercent: p.gstPercent.toString(),
        }))}
        initialValues={{
          customerId: quotation.customerId ?? "",
          leadId: quotation.leadId ?? "",
          validUntil: quotation.validUntil
            ? quotation.validUntil.toISOString().slice(0, 10)
            : "",
          discountPercent: quotation.discountPercent.toString(),
          freightAmount: quotation.freightAmount.toString(),
          termsAndConditions: quotation.termsAndConditions ?? "",
          notes: quotation.notes ?? "",
          items: quotation.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity.toString(),
            unitPrice: item.unitPrice.toString(),
            discountPercent: item.discountPercent.toString(),
          })),
        }}
      />
    </div>
  );
}
