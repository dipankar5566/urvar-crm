import { prisma } from "@/lib/prisma";

/**
 * Sequence numbers are derived from row counts. Fine for a single-tenant,
 * low-concurrency internal tool; callers retry once on a unique-constraint
 * collision (see leads/actions.ts) rather than serializing every create.
 */
export async function generateLeadNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.lead.count();
  return `LD-${year}-${String(count + 1).padStart(4, "0")}`;
}

export async function generateCustomerNumber(): Promise<string> {
  const count = await prisma.customer.count();
  return `CUST-${String(count + 1).padStart(4, "0")}`;
}

export async function generateQuotationNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.quotation.count();
  return `QT-${year}-${String(count + 1).padStart(4, "0")}`;
}

export async function generateOrderNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.order.count();
  return `ORD-${year}-${String(count + 1).padStart(4, "0")}`;
}
