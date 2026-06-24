import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { can, scopeWhere } from "@/lib/permissions";
import { renderQuotationPdf } from "@/lib/pdf/quotation-pdf";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ quotationId: string }> },
) {
  const { quotationId } = await params;
  const user = await requireUser();
  const scope = can(user.role, "quotations", "read");
  if (scope === "none") {
    return new NextResponse("Forbidden", { status: 403 });
  }

  let where: Record<string, unknown> = { id: quotationId, ...scopeWhere(scope, user, "createdById") };
  if (scope === "territory") {
    where = {
      id: quotationId,
      OR: [
        { customer: { state: { in: user.territoryStates } } },
        { lead: { state: { in: user.territoryStates } } },
      ],
    };
  }

  const quotation = await prisma.quotation.findFirst({
    where,
    include: {
      customer: true,
      lead: true,
      items: { include: { product: true } },
    },
  });
  if (!quotation) {
    return new NextResponse("Not found", { status: 404 });
  }

  const recipient = quotation.customer ?? quotation.lead;
  const buffer = await renderQuotationPdf({
    quotationNumber: quotation.quotationNumber,
    status: quotation.status,
    createdAt: quotation.createdAt,
    validUntil: quotation.validUntil,
    subtotal: quotation.subtotal.toString(),
    discountPercent: quotation.discountPercent.toString(),
    discountAmount: quotation.discountAmount.toString(),
    freightAmount: quotation.freightAmount.toString(),
    taxAmount: quotation.taxAmount.toString(),
    totalAmount: quotation.totalAmount.toString(),
    termsAndConditions: quotation.termsAndConditions,
    notes: quotation.notes,
    recipientName: recipient?.name ?? "—",
    recipientReference: quotation.customer
      ? quotation.customer.customerNumber
      : quotation.lead
        ? quotation.lead.leadNumber
        : "",
    recipientLocation: recipient ? `${recipient.district}, ${recipient.state}` : "",
    items: quotation.items.map((item) => ({
      productName: item.product.name,
      sku: item.product.sku,
      category: item.product.category,
      unit: item.product.unit,
      quantity: item.quantity.toString(),
      unitPrice: item.unitPrice.toString(),
      discountPercent: item.discountPercent.toString(),
      lineTotal: item.lineTotal.toString(),
    })),
  });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${quotation.quotationNumber}.pdf"`,
    },
  });
}
