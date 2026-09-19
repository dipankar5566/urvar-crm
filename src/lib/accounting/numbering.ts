import { Prisma } from "@/generated/prisma/client";
import { financialYearLabel } from "./fiscal";

/**
 * Gapless, per-financial-year document numbering.
 *
 * The CRM's existing `src/lib/id-sequences.ts` derives numbers from
 * `COUNT(*) + 1` and retries on collision. That is fine for a lead number and
 * unusable for a tax invoice: GST Rule 46(b) requires a consecutive serial
 * unique within a financial year, and a row count is neither gapless (a
 * deleted row shifts it) nor per-FY (the prefix rolls in April, the counter
 * does not) nor safe under concurrency.
 *
 * So the counter lives in a row and is advanced by a single atomic statement.
 * `UPDATE ... RETURNING` takes a row-level write lock for the duration of the
 * enclosing transaction, so two concurrent invoices serialise here and each
 * gets its own number — no retry loop, no gap.
 *
 * Separator is "/" rather than the "-" used by lead/quotation numbers,
 * because INV/2026-27/0001 is the form Indian invoices are written in and
 * because it keeps statutory documents visually distinct from CRM ones.
 */

export const DOCUMENT_TYPES = {
  JOURNAL: "JOURNAL",
  SALES_INVOICE: "SALES_INVOICE",
  RECEIPT: "RECEIPT",
  CREDIT_NOTE: "CREDIT_NOTE",
  DEBIT_NOTE: "DEBIT_NOTE",
  SUPPLIER_PAYMENT: "SUPPLIER_PAYMENT",
} as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[keyof typeof DOCUMENT_TYPES];

/** Defaults used when a series has to be created on first use. */
const DEFAULT_PREFIX: Record<DocumentType, string> = {
  JOURNAL: "JV",
  SALES_INVOICE: "INV",
  RECEIPT: "RCT",
  CREDIT_NOTE: "CRN",
  DEBIT_NOTE: "DBN",
  SUPPLIER_PAYMENT: "SPY",
};

export type AllocateArgs = {
  companyId: string;
  documentType: DocumentType;
  financialYear: number;
  fyStartMonth?: number;
};

/**
 * Reserve the next number in a series and return the formatted document
 * number. MUST be called inside the same transaction that inserts the
 * document, so an aborted insert releases the number rather than burning it.
 */
export async function allocateDocumentNumber(
  tx: Prisma.TransactionClient,
  { companyId, documentType, financialYear, fyStartMonth = 4 }: AllocateArgs,
): Promise<string> {
  let row = await advance(tx, companyId, documentType, financialYear);

  if (!row) {
    // First document of this type this financial year. Create the series,
    // tolerating a concurrent creator, then advance for real.
    await tx.documentSeries.createMany({
      data: [
        {
          companyId,
          documentType,
          financialYear,
          prefix: DEFAULT_PREFIX[documentType],
          padding: 4,
          nextNumber: 1,
        },
      ],
      skipDuplicates: true,
    });
    row = await advance(tx, companyId, documentType, financialYear);
  }

  if (!row) {
    throw new Error(
      `Could not allocate a ${documentType} number for FY ${financialYear}.`,
    );
  }

  const serial = String(row.allocated).padStart(row.padding, "0");
  return `${row.prefix}/${financialYearLabel(financialYear, fyStartMonth)}/${serial}`;
}

type AdvancedRow = { allocated: number; prefix: string; padding: number };

async function advance(
  tx: Prisma.TransactionClient,
  companyId: string,
  documentType: string,
  financialYear: number,
): Promise<AdvancedRow | null> {
  const rows = await tx.$queryRaw<AdvancedRow[]>`
    UPDATE "DocumentSeries"
       SET "nextNumber" = "nextNumber" + 1,
           "updatedAt"  = NOW()
     WHERE "companyId"     = ${companyId}
       AND "documentType"  = ${documentType}
       AND "financialYear" = ${financialYear}
    RETURNING ("nextNumber" - 1)::int AS "allocated", "prefix", "padding"
  `;
  return rows[0] ?? null;
}

/**
 * What the next number *would* be, without consuming it. For showing a
 * preview on a draft form — never for assigning a number, since by the time
 * the form is submitted another user may have taken it.
 */
export async function peekNextNumber(
  tx: Prisma.TransactionClient,
  { companyId, documentType, financialYear, fyStartMonth = 4 }: AllocateArgs,
): Promise<string> {
  const series = await tx.documentSeries.findUnique({
    where: {
      companyId_documentType_financialYear: { companyId, documentType, financialYear },
    },
    select: { prefix: true, padding: true, nextNumber: true },
  });
  const prefix = series?.prefix ?? DEFAULT_PREFIX[documentType];
  const padding = series?.padding ?? 4;
  const next = series?.nextNumber ?? 1;
  return `${prefix}/${financialYearLabel(financialYear, fyStartMonth)}/${String(next).padStart(padding, "0")}`;
}
