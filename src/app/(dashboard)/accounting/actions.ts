"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { assertCan } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { requireCompany } from "@/lib/accounting/company";
import { periodsForYear, financialYearLabel } from "@/lib/accounting/fiscal";

type ActionResult = { error: string } | { success: true };

/**
 * Close a financial period. Postings dated inside it are refused afterwards
 * (enforced in the posting service, not here — hiding the button is not the
 * control).
 *
 * Closing is reversible; LOCKED is not, and is reserved for a period whose
 * GST returns have been filed.
 */
export async function closePeriod(periodId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");

  const period = await prisma.financialPeriod.findUnique({ where: { id: periodId } });
  if (!period) return { error: "That period does not exist." };
  if (period.status !== "OPEN") return { error: `${period.label} is already ${period.status.toLowerCase()}.` };

  await prisma.$transaction(async (tx) => {
    await tx.financialPeriod.update({
      where: { id: periodId },
      data: { status: "CLOSED", closedAt: new Date(), closedById: user.id },
    });
    await logAudit(
      {
        userId: user.id,
        action: "CLOSE_PERIOD",
        entityType: "FinancialPeriod",
        entityId: periodId,
        oldValue: { status: period.status },
        newValue: { status: "CLOSED", label: period.label },
      },
      tx,
    );
  });

  revalidatePath("/accounting/periods");
  return { success: true };
}

/** Reopen a closed period. A LOCKED period is permanently sealed. */
export async function reopenPeriod(periodId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");
  if (user.role !== "SUPER_ADMIN") {
    return { error: "Only a Super Admin can reopen a closed period." };
  }

  const period = await prisma.financialPeriod.findUnique({ where: { id: periodId } });
  if (!period) return { error: "That period does not exist." };
  if (period.status === "LOCKED") {
    return { error: `${period.label} is locked — returns have been filed against it. It cannot be reopened.` };
  }
  if (period.status === "OPEN") return { error: `${period.label} is already open.` };

  await prisma.$transaction(async (tx) => {
    await tx.financialPeriod.update({
      where: { id: periodId },
      data: { status: "OPEN", closedAt: null, closedById: null },
    });
    await logAudit(
      {
        userId: user.id,
        action: "REOPEN_PERIOD",
        entityType: "FinancialPeriod",
        entityId: periodId,
        oldValue: { status: period.status },
        newValue: { status: "OPEN", label: period.label },
      },
      tx,
    );
  });

  revalidatePath("/accounting/periods");
  return { success: true };
}

/**
 * Seal a period permanently. Separate from CLOSED because filing a return is
 * a one-way door: after this nothing can post into, or reopen, the period.
 */
export async function lockPeriod(periodId: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "approve");
  if (user.role !== "SUPER_ADMIN") {
    return { error: "Only a Super Admin can lock a period." };
  }

  const period = await prisma.financialPeriod.findUnique({ where: { id: periodId } });
  if (!period) return { error: "That period does not exist." };
  if (period.status === "LOCKED") return { error: `${period.label} is already locked.` };

  await prisma.$transaction(async (tx) => {
    await tx.financialPeriod.update({
      where: { id: periodId },
      data: { status: "LOCKED", closedAt: period.closedAt ?? new Date(), closedById: period.closedById ?? user.id },
    });
    await logAudit(
      {
        userId: user.id,
        action: "LOCK_PERIOD",
        entityType: "FinancialPeriod",
        entityId: periodId,
        oldValue: { status: period.status },
        newValue: { status: "LOCKED", label: period.label },
      },
      tx,
    );
  });

  revalidatePath("/accounting/periods");
  return { success: true };
}

/** Create the twelve periods of a financial year. Idempotent. */
export async function openFinancialYear(financialYear: number): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "accounting", "write");

  if (!Number.isInteger(financialYear) || financialYear < 2000 || financialYear > 2100) {
    return { error: "That is not a plausible financial year." };
  }

  const company = await requireCompany();
  const periods = periodsForYear(financialYear, company.fyStartMonth);

  const created = await prisma.$transaction(async (tx) => {
    const result = await tx.financialPeriod.createMany({
      data: periods.map((p) => ({
        companyId: company.id,
        financialYear: p.financialYear,
        periodNumber: p.periodNumber,
        label: p.label,
        startDate: p.startDate,
        endDate: p.endDate,
      })),
      skipDuplicates: true,
    });
    if (result.count > 0) {
      await logAudit(
        {
          userId: user.id,
          action: "OPEN_FINANCIAL_YEAR",
          entityType: "FinancialPeriod",
          entityId: `FY${financialYear}`,
          newValue: {
            financialYear: financialYearLabel(financialYear, company.fyStartMonth),
            periodsCreated: result.count,
          },
        },
        tx,
      );
    }
    return result.count;
  });

  if (created === 0) {
    return { error: `FY ${financialYearLabel(financialYear, company.fyStartMonth)} is already open.` };
  }

  revalidatePath("/accounting/periods");
  return { success: true };
}

/**
 * Sign off a `TaxRate` row so the tax engine will price invoices against it.
 *
 * `resolveTaxRate()` (src/lib/accounting/tax.ts) refuses to price a line from
 * any row with `isVerified: false` — seeded rates start unverified on purpose
 * (see scripts/seed-accounting.ts). This is the only place that flips the
 * flag, and it requires a note recording the basis for sign-off rather than
 * treating it as a formality.
 */
export async function verifyTaxRate(taxRateId: string, note: string): Promise<ActionResult> {
  const user = await requireUser();
  assertCan(user.role, "gst", "approve");
  if (!note.trim()) return { error: "A verification note is required." };

  const rate = await prisma.taxRate.findUnique({ where: { id: taxRateId } });
  if (!rate) return { error: "That tax rate does not exist." };
  if (rate.isVerified) return { error: "Already verified." };

  await prisma.$transaction(async (tx) => {
    await tx.taxRate.update({
      where: { id: taxRateId },
      data: { isVerified: true, verifiedNote: note.trim() },
    });
    await logAudit(
      {
        userId: user.id,
        action: "VERIFY_TAX_RATE",
        entityType: "TaxRate",
        entityId: taxRateId,
        oldValue: { isVerified: false },
        newValue: {
          isVerified: true,
          hsnCode: rate.hsnCode,
          ratePercent: rate.ratePercent.toString(),
          note: note.trim(),
        },
      },
      tx,
    );
  });

  revalidatePath("/accounting/tax-rates");
  return { success: true };
}
