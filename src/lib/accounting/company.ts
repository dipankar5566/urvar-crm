import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * The selling legal entity.
 *
 * Single-entity by design (see the schema comment on `Company`), so this
 * returns the one active row. It throws rather than returning null: every
 * caller is mid-posting or mid-invoice and has no sensible fallback, and a
 * silent null here would surface as a confusing FK error three frames later.
 */
export async function requireCompany(db: Db = prisma) {
  const company = await db.company.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!company) {
    throw new Error(
      "No company record exists. Run the chart-of-accounts seed " +
        "(npm run db:seed-accounting) before posting anything.",
    );
  }
  return company;
}
