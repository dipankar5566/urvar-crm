import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { can, scopeWhere } from "@/lib/permissions";

const TAKE = 5;

export async function GET(req: NextRequest) {
  const user = await requireUser();
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) {
    return NextResponse.json({ leads: [], customers: [], quotations: [], products: [] });
  }

  const contains = { contains: q, mode: "insensitive" as const };

  const leadScope = can(user.role, "leads", "read");
  const customerScope = can(user.role, "customers", "read");
  const quotationScope = can(user.role, "quotations", "read");
  const productScope = can(user.role, "products", "read");

  const [leads, customers, quotations, products] = await Promise.all([
    leadScope === "none"
      ? Promise.resolve([])
      : prisma.lead.findMany({
          where: {
            ...scopeWhere(leadScope, user, "assignedToId"),
            OR: [{ name: contains }, { phone: contains }, { leadNumber: contains }],
          },
          select: { id: true, name: true, leadNumber: true, phone: true },
          take: TAKE,
        }),
    customerScope === "none"
      ? Promise.resolve([])
      : prisma.customer.findMany({
          where: {
            ...scopeWhere(customerScope, user, "assignedToId"),
            OR: [{ name: contains }, { phone: contains }, { customerNumber: contains }],
          },
          select: { id: true, name: true, customerNumber: true, phone: true },
          take: TAKE,
        }),
    quotationScope === "none"
      ? Promise.resolve([])
      : prisma.quotation.findMany({
          where: {
            // Quotation has no scalar `state` field, so the generic
            // scopeWhere("territory") fallback (which filters on `state`)
            // doesn't apply — territory is resolved via the related
            // lead/customer instead, same as the quotation PDF route.
            ...(quotationScope === "territory"
              ? {
                  OR: [
                    { customer: { state: { in: user.territoryStates } } },
                    { lead: { state: { in: user.territoryStates } } },
                  ],
                }
              : scopeWhere(quotationScope, user, "createdById")),
            quotationNumber: contains,
          },
          select: { id: true, quotationNumber: true },
          take: TAKE,
        }),
    productScope === "none"
      ? Promise.resolve([])
      : prisma.product.findMany({
          where: { OR: [{ name: contains }, { sku: contains }] },
          select: { id: true, name: true, sku: true },
          take: TAKE,
        }),
  ]);

  return NextResponse.json({ leads, customers, quotations, products });
}
