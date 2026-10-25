import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { logAudit } from "@/lib/audit";
import { postJournalEntry, reverseJournalEntry } from "./posting";
import { loadAccountMap, requireAccount } from "./account-map";

/**
 * Cheque lifecycle (docs/VYAPAR_PARITY_SPEC.md §2.3).
 *
 * REA round 7 on a Vyapar test company showed exactly two states — a cheque
 * is either held (Vyapar's built-in "Cheque" account) or transferred to a
 * bank on a date — plus Reopen, which moves it back. There is no bounce
 * state; a bounced cheque is reopened and its receipt cancelled, which
 * re-opens the invoice the same way any cancelled receipt does.
 *
 * The holding accounts are UNDEPOSITED_CHEQUES (asset, received) and
 * UNWITHDRAWN_CHEQUES (liability, issued). A receipt or supplier payment that
 * posts to one of them opens a Cheque here; depositing/clearing posts the
 * move to the bank; reopening reverses that move.
 */

export class ChequeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChequeError";
  }
}

/** Open a RECEIVED cheque when a receipt was deposited to UNDEPOSITED_CHEQUES. */
export async function openChequeForReceipt(
  tx: Prisma.TransactionClient,
  receipt: { id: string; amount: Prisma.Decimal; receiptDate: Date; reference: string | null },
): Promise<string> {
  const cheque = await tx.cheque.create({
    data: {
      direction: "RECEIVED",
      amount: receipt.amount,
      chequeDate: receipt.receiptDate,
      chequeNumber: receipt.reference,
      receiptId: receipt.id,
    },
  });
  return cheque.id;
}

/** Open an ISSUED cheque when a supplier payment was made from UNWITHDRAWN_CHEQUES. */
export async function openChequeForSupplierPayment(
  tx: Prisma.TransactionClient,
  payment: { id: string; amount: Prisma.Decimal; paymentDate: Date; reference: string | null },
): Promise<string> {
  const cheque = await tx.cheque.create({
    data: {
      direction: "ISSUED",
      amount: payment.amount,
      chequeDate: payment.paymentDate,
      chequeNumber: payment.reference,
      supplierPaymentId: payment.id,
    },
  });
  return cheque.id;
}

async function assertBankLedger(tx: Prisma.TransactionClient, accountId: string) {
  const account = await tx.ledgerAccount.findUnique({ where: { id: accountId }, include: { parent: true } });
  if (!account || !account.isActive || !account.isPostable || account.parent?.code !== "1120") {
    throw new ChequeError("Choose an active bank account under 1120 Bank Accounts.");
  }
  return account;
}

/**
 * Deposit a received cheque (Dr bank / Cr UNDEPOSITED_CHEQUES) or clear an
 * issued one (Dr UNWITHDRAWN_CHEQUES / Cr bank). Vyapar's "Deposit" and
 * "Withdraw" on its Cheques screen.
 */
export async function transferCheque(
  input: { chequeId: string; bankLedgerAccountId: string; transferDate: Date; transferredById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<{ entryId: string }> {
  const run = async (tx: Prisma.TransactionClient) => {
    const cheque = await tx.cheque.findUnique({
      where: { id: input.chequeId },
      include: { receipt: { include: { customer: true } }, supplierPayment: { include: { supplier: true } } },
    });
    if (!cheque) throw new ChequeError("That cheque does not exist.");
    if (cheque.status !== "OPEN") throw new ChequeError(`This cheque is ${cheque.status.toLowerCase()}, not open.`);
    if (input.transferDate < cheque.chequeDate) {
      throw new ChequeError("A cheque cannot be deposited or cleared before the date it was received or issued.");
    }
    const bank = await assertBankLedger(tx, input.bankLedgerAccountId);

    const map = await loadAccountMap(tx);
    const received = cheque.direction === "RECEIVED";
    const holdingId = requireAccount(map, received ? "UNDEPOSITED_CHEQUES" : "UNWITHDRAWN_CHEQUES");
    const party = received ? cheque.receipt?.customer.name : cheque.supplierPayment?.supplier.name;
    const revision = cheque.transferRevision + 1;

    const posted = await postJournalEntry(
      {
        entryDate: input.transferDate,
        narration: `Cheque ${cheque.chequeNumber ?? ""} ${received ? "deposited to" : "cleared from"} ${bank.name}${party ? ` — ${party}` : ""}`.replace(/\s+/g, " "),
        sourceType: "CHEQUE_TRANSFER",
        sourceId: cheque.id,
        idempotencyKey: `CHEQUE_TRANSFER:${cheque.id}:${revision}`,
        postedById: input.transferredById,
        lines: received
          ? [
              { accountId: bank.id, debit: cheque.amount },
              { accountId: holdingId, credit: cheque.amount },
            ]
          : [
              { accountId: holdingId, debit: cheque.amount },
              { accountId: bank.id, credit: cheque.amount },
            ],
      },
      tx,
    );

    await tx.cheque.update({
      where: { id: cheque.id },
      data: {
        status: received ? "DEPOSITED" : "CLEARED",
        bankLedgerAccountId: bank.id,
        transferDate: input.transferDate,
        transferEntryId: posted.entryId,
        transferRevision: revision,
      },
    });

    await logAudit(
      {
        userId: input.transferredById,
        action: "UPDATE",
        entityType: "Cheque",
        entityId: cheque.id,
        oldValue: { status: "OPEN" },
        newValue: { status: received ? "DEPOSITED" : "CLEARED", bank: bank.code },
      },
      tx,
    );
    return { entryId: posted.entryId };
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/** Vyapar's Reopen: reverse the deposit/clear and hold the cheque again. */
export async function reopenCheque(
  input: { chequeId: string; reason: string; reopenedById: string },
  existingTx?: Prisma.TransactionClient,
): Promise<void> {
  const run = async (tx: Prisma.TransactionClient) => {
    const cheque = await tx.cheque.findUnique({ where: { id: input.chequeId } });
    if (!cheque) throw new ChequeError("That cheque does not exist.");
    if ((cheque.status !== "DEPOSITED" && cheque.status !== "CLEARED") || !cheque.transferEntryId) {
      throw new ChequeError("Only a deposited or cleared cheque can be reopened.");
    }
    if (input.reason.trim().length < 3) throw new ChequeError("Give a reason for reopening the cheque.");

    await reverseJournalEntry({ entryId: cheque.transferEntryId, reason: input.reason, postedById: input.reopenedById }, tx);
    await tx.cheque.update({
      where: { id: cheque.id },
      data: { status: "OPEN", bankLedgerAccountId: null, transferDate: null, transferEntryId: null },
    });

    await logAudit(
      {
        userId: input.reopenedById,
        action: "UPDATE",
        entityType: "Cheque",
        entityId: cheque.id,
        oldValue: { status: cheque.status },
        newValue: { status: "OPEN", reason: input.reason },
      },
      tx,
    );
  };

  if (existingTx) return run(existingTx);
  return prisma.$transaction(run);
}

/**
 * Called before a receipt / supplier payment is cancelled. An open cheque is
 * marked CANCELLED (the document's own reversal clears the holding account);
 * a deposited/cleared one must be reopened first, or the reversal would
 * credit the holding account while the bank still holds the money.
 */
export async function releaseChequeForCancellation(
  tx: Prisma.TransactionClient,
  where: { receiptId: string } | { supplierPaymentId: string },
): Promise<void> {
  const cheque = await tx.cheque.findFirst({ where });
  if (!cheque || cheque.status === "CANCELLED") return;
  if (cheque.status !== "OPEN") {
    throw new ChequeError(
      `Its cheque${cheque.chequeNumber ? ` ${cheque.chequeNumber}` : ""} is ${cheque.status.toLowerCase()} — reopen the cheque first.`,
    );
  }
  await tx.cheque.update({ where: { id: cheque.id }, data: { status: "CANCELLED" } });
}
