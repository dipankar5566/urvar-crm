import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import type { LedgerAccountType, NormalBalance } from "@/generated/prisma/enums";
import { defaultNormalBalance } from "./chart-of-accounts";
import { logAudit } from "@/lib/audit";

/**
 * The only module outside `scripts/seed-accounting.ts` permitted to write
 * `LedgerAccount` — the same "one owner per table" discipline `posting.ts`
 * enforces for `JournalEntry`/`JournalLine`. Before this module existed, the
 * seed script was the ONLY writer in the entire repo; a second, uncoordinated
 * write path (an ad-hoc Server Action reaching into `prisma.ledgerAccount`
 * directly) is exactly how the "code immutable once posted" and "never
 * deactivate a mapped account" rules would get bypassed by accident.
 */

export class LedgerAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerAccountError";
  }
}

const CODE_PATTERN = /^\d{4}$/;

export type CreateLedgerAccountInput = {
  code: string;
  name: string;
  type: LedgerAccountType;
  parentCode: string;
  normalBalance?: NormalBalance;
  isPostable?: boolean;
  description?: string | null;
};

/**
 * Create a new account under an existing group. Used directly by the Chart
 * of Accounts UI, and by `createLoan()` to mint a loan's own liability
 * account under `2220` without the loan form needing the COA page to exist
 * first.
 */
export async function createLedgerAccount(
  input: CreateLedgerAccountInput,
  existingTx?: Prisma.TransactionClient,
): Promise<{ accountId: string; code: string }> {
  const run = async (tx: Prisma.TransactionClient): Promise<{ accountId: string; code: string }> => {
    const code = input.code.trim();
    if (!CODE_PATTERN.test(code)) {
      throw new LedgerAccountError(`"${code}" is not a valid account code — codes are exactly four digits.`);
    }
    const name = input.name.trim();
    if (!name) throw new LedgerAccountError("An account needs a name.");

    const existing = await tx.ledgerAccount.findUnique({ where: { code } });
    if (existing) throw new LedgerAccountError(`Account code ${code} is already in use (${existing.name}).`);

    const parent = await tx.ledgerAccount.findUnique({ where: { code: input.parentCode } });
    if (!parent) throw new LedgerAccountError(`Parent account ${input.parentCode} does not exist.`);
    if (parent.isPostable) {
      throw new LedgerAccountError(
        `${parent.code} ${parent.name} is not a grouping account — accounts can only be created under a ` +
          `non-postable parent, or postings to the parent and its new sibling would double-count.`,
      );
    }
    if (parent.type !== input.type) {
      throw new LedgerAccountError(
        `${parent.code} ${parent.name} is a ${parent.type} group — a ${input.type} account cannot live under it.`,
      );
    }

    const account = await tx.ledgerAccount.create({
      data: {
        code,
        name,
        type: input.type,
        normalBalance: input.normalBalance ?? defaultNormalBalance(input.type),
        parentId: parent.id,
        isPostable: input.isPostable ?? true,
        isSystem: false,
        description: input.description?.trim() || null,
      },
    });

    return { accountId: account.id, code: account.code };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

export type CreateLedgerAccountForActionInput = CreateLedgerAccountInput & { userId: string };

/** Server Action wrapper: creates the account and writes the audit entry. */
export async function createLedgerAccountAudited(
  input: CreateLedgerAccountForActionInput,
): Promise<{ accountId: string; code: string }> {
  return prisma.$transaction(async (tx) => {
    const result = await createLedgerAccount(input, tx);
    await logAudit(
      {
        userId: input.userId,
        action: "CREATE",
        entityType: "LedgerAccount",
        entityId: result.accountId,
        newValue: { code: result.code, name: input.name, type: input.type, parentCode: input.parentCode },
      },
      tx,
    );
    return result;
  });
}

/**
 * Rename or re-describe an account. Always allowed, regardless of posting
 * history — `chart-of-accounts.ts`'s own comment promises "Names may be
 * edited by an accountant." (`scripts/seed-accounting.ts` must never revert
 * this on its next run — see the fix alongside this module.)
 */
export async function renameLedgerAccount(
  input: { accountId: string; name: string; description?: string | null; userId: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new LedgerAccountError("An account needs a name.");

  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const account = await tx.ledgerAccount.findUnique({ where: { id: input.accountId } });
    if (!account) throw new LedgerAccountError("That account does not exist.");

    await tx.ledgerAccount.update({
      where: { id: input.accountId },
      data: { name, description: input.description?.trim() || null },
    });

    await logAudit(
      {
        userId: input.userId,
        action: "UPDATE",
        entityType: "LedgerAccount",
        entityId: input.accountId,
        oldValue: { name: account.name, description: account.description },
        newValue: { name, description: input.description ?? null },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/**
 * Activate or deactivate an account. Deactivation is refused whenever hiding
 * the account would hide something real: a system account, a non-zero
 * balance, an active child, or anything else still pointing at it. No
 * button hides these cases — the guard lives here, per `closePeriod`'s own
 * comment that hiding a button is not the control.
 */
export async function setLedgerAccountActive(
  input: { accountId: string; isActive: boolean; userId: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient): Promise<void> => {
    const account = await tx.ledgerAccount.findUnique({ where: { id: input.accountId } });
    if (!account) throw new LedgerAccountError("That account does not exist.");
    if (account.isActive === input.isActive) return;

    if (!input.isActive) {
      if (account.isSystem) {
        throw new LedgerAccountError(
          `${account.code} ${account.name} is a system account and can never be deactivated — the posting ` +
            `service depends on it existing.`,
        );
      }

      const mapping = await tx.accountMapping.findFirst({ where: { accountId: account.id } });
      if (mapping) {
        throw new LedgerAccountError(
          `${account.code} ${account.name} is mapped to the posting role "${mapping.key}" — remap that role to ` +
            `a different account first.`,
        );
      }

      const activeChild = await tx.ledgerAccount.findFirst({ where: { parentId: account.id, isActive: true } });
      if (activeChild) {
        throw new LedgerAccountError(
          `${account.code} ${account.name} still has active child accounts — deactivate those first.`,
        );
      }

      const agg = await tx.journalLine.aggregate({
        where: { accountId: account.id, entry: { status: { not: "DRAFT" } } },
        _sum: { debit: true, credit: true },
      });
      const debit = agg._sum.debit ?? new Prisma.Decimal(0);
      const credit = agg._sum.credit ?? new Prisma.Decimal(0);
      if (!debit.minus(credit).isZero()) {
        throw new LedgerAccountError(
          `${account.code} ${account.name} has a non-zero balance — deactivating it would hide a real amount ` +
            `from every report.`,
        );
      }
    }

    await tx.ledgerAccount.update({ where: { id: account.id }, data: { isActive: input.isActive } });

    await logAudit(
      {
        userId: input.userId,
        action: input.isActive ? "ACTIVATE" : "DEACTIVATE",
        entityType: "LedgerAccount",
        entityId: account.id,
        oldValue: { isActive: account.isActive },
        newValue: { isActive: input.isActive },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/**
 * The next free code under a parent group, for a form's placeholder — e.g.
 * suggesting `2221` for a new loan account under `2220 Loan Accounts`.
 * Best-effort only: a concurrent create can still race it, which
 * `createLedgerAccount()`'s own unique-code check catches.
 */
export async function nextChildCode(parentCode: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<string> {
  const parent = await db.ledgerAccount.findUnique({ where: { code: parentCode } });
  if (!parent) throw new LedgerAccountError(`Parent account ${parentCode} does not exist.`);

  const children = await db.ledgerAccount.findMany({
    where: { parentId: parent.id },
    select: { code: true },
    orderBy: { code: "desc" },
    take: 1,
  });
  if (children.length === 0) return `${parentCode.slice(0, 3)}1`;

  const lastCode = Number(children[0].code);
  return String(lastCode + 1);
}
