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
