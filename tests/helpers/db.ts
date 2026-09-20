import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Run a test body inside a transaction that is ALWAYS rolled back.
 *
 * This repo has no separate test database and cannot get one: DATABASE_URL
 * points at the live `urvar_crm`, and the app's role (`urvar_app`) has
 * `rolcreatedb = false` — the same reason `prisma migrate dev` fails with
 * P3014 on this box.
 *
 * So integration tests run against the real schema and the real seeded chart
 * of accounts, but every write is discarded: the body runs inside an
 * interactive transaction that is unwound by throwing a sentinel. The throw is
 * unconditional — there is no path on which this transaction commits.
 *
 * Document numbers allocated inside the body are released by the rollback, so
 * tests do not burn invoice serials either.
 */
class Rollback extends Error {
  constructor() {
    super("intentional test rollback");
    this.name = "Rollback";
  }
}

export async function withRollback<T>(
  body: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let captured!: T;
  try {
    await prisma.$transaction(async (tx) => {
      captured = await body(tx);
      // Unconditional: the only way out of this transaction is a rollback.
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return captured;
}

/** The seeded super admin, used as the posting actor in tests. */
export async function testUserId(tx: Prisma.TransactionClient): Promise<string> {
  const user = await tx.user.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!user) throw new Error("No active user exists to post as.");
  return user.id;
}

/** Resolve a seeded ledger account id by its chart-of-accounts code. */
export async function accountId(tx: Prisma.TransactionClient, code: string): Promise<string> {
  const account = await tx.ledgerAccount.findUnique({ where: { code }, select: { id: true } });
  if (!account) {
    throw new Error(`Ledger account ${code} is not seeded. Run npm run db:seed-accounting.`);
  }
  return account.id;
}

/** A date guaranteed to sit inside an OPEN period, for posting tests. */
export async function openPeriodDate(tx: Prisma.TransactionClient): Promise<Date> {
  const period = await tx.financialPeriod.findFirst({
    where: { status: "OPEN" },
    orderBy: { startDate: "asc" },
    select: { startDate: true },
  });
  if (!period) throw new Error("No OPEN financial period. Run npm run db:seed-accounting.");
  const d = new Date(period.startDate);
  d.setHours(12, 0, 0, 0); // clear of any boundary/timezone edge
  return d;
}

/** A verified TaxRate row so priceLine/resolveTaxRate has something to find. */
export async function ensureVerifiedTaxRate(
  tx: Prisma.TransactionClient,
  hsnCode: string,
  ratePercent: string | number = 5,
): Promise<void> {
  const existing = await tx.taxRate.findFirst({ where: { hsnCode, isVerified: true } });
  if (existing) return;
  await tx.taxRate.create({
    data: {
      hsnCode,
      ratePercent: String(ratePercent),
      treatment: "TAXABLE",
      effectiveFrom: new Date(2000, 0, 1),
      isVerified: true,
      verifiedNote: "Test fixture.",
    },
  });
}

let seq = 0;
/** A throwaway product with a real HSN, for invoicing tests. */
export async function testProduct(
  tx: Prisma.TransactionClient,
  overrides: { hsnCode?: string; unit?: string; mrp?: string | number } = {},
) {
  const n = ++seq;
  return tx.product.create({
    data: {
      sku: `TEST-SKU-${Date.now()}-${n}`,
      name: `Test Product ${n}`,
      category: "VERMICOMPOST",
      unit: overrides.unit ?? "kg",
      hsnCode: overrides.hsnCode ?? "3101",
      mrp: String(overrides.mrp ?? 100),
      gstPercent: "5",
    },
  });
}

/** A throwaway customer in a given state, for tax-split tests. */
export async function testCustomer(
  tx: Prisma.TransactionClient,
  overrides: { state?: string; gstNumber?: string | null } = {},
) {
  const n = ++seq;
  return tx.customer.create({
    data: {
      customerNumber: `TEST-CUST-${Date.now()}-${n}`,
      name: `Test Customer ${n}`,
      phone: "9800000000",
      state: overrides.state ?? "West Bengal",
      district: "Kolkata",
      gstNumber: overrides.gstNumber ?? null,
    },
  });
}

/** An Order with one line, ready to invoice. */
export async function testOrderWithLine(
  tx: Prisma.TransactionClient,
  opts: {
    userId: string;
    customerId: string;
    productId: string;
    quantity?: string | number;
    unitPrice?: string | number;
  },
) {
  const n = ++seq;
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: opts.customerId } });
  const quantity = String(opts.quantity ?? 10);
  const unitPrice = String(opts.unitPrice ?? 100);
  const lineTotal = (Number(quantity) * Number(unitPrice)).toFixed(2);
  return tx.order.create({
    data: {
      orderNumber: `TEST-ORD-${Date.now()}-${n}`,
      customerId: opts.customerId,
      totalAmount: lineTotal,
      state: customer.state,
      district: customer.district,
      createdById: opts.userId,
      items: {
        create: [
          {
            productId: opts.productId,
            description: "Test line",
            quantity,
            unitPrice,
            lineTotal,
            lineNumber: 1,
          },
        ],
      },
    },
    include: { items: true },
  });
}
