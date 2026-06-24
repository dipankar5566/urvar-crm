import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { can, scopeWhere } from "@/lib/permissions";
import { QuotationForm } from "../quotation-form";

export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; leadId?: string }>;
}) {
  const user = await requireUser();
  const { customerId, leadId } = await searchParams;
  if (can(user.role, "quotations", "write") === "none") notFound();

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
        <h1 className="text-2xl font-semibold tracking-tight">New Quotation</h1>
        <p className="text-sm text-muted-foreground">
          Build a quotation with line items, discounts, and GST.
        </p>
      </div>
      <QuotationForm
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
          customerId: customerId ?? "",
          leadId: leadId ?? "",
          validUntil: "",
          discountPercent: "0",
          freightAmount: "0",
          termsAndConditions: "",
          notes: "",
          items: [{ productId: "", quantity: "1", unitPrice: "", discountPercent: "0" }],
        }}
      />
    </div>
  );
}
