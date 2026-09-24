-- CreateEnum
CREATE TYPE "CashBankTxnType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'BANK_CHARGE', 'INTEREST_INCOME', 'CASH_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FixedAssetStatus" AS ENUM ('ACTIVE', 'DISPOSED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JournalSourceType" ADD VALUE 'CASH_BANK_TRANSFER';
ALTER TYPE "JournalSourceType" ADD VALUE 'LOAN';
ALTER TYPE "JournalSourceType" ADD VALUE 'LOAN_REPAYMENT';
ALTER TYPE "JournalSourceType" ADD VALUE 'FIXED_ASSET';
ALTER TYPE "JournalSourceType" ADD VALUE 'DEPRECIATION';
ALTER TYPE "JournalSourceType" ADD VALUE 'ASSET_DISPOSAL';

-- CreateTable
CREATE TABLE "CashBankTransaction" (
    "id" TEXT NOT NULL,
    "type" "CashBankTxnType" NOT NULL,
    "txnDate" TIMESTAMP(3) NOT NULL,
    "debitAccountId" TEXT NOT NULL,
    "creditAccountId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "postedEntryId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashBankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "lenderName" TEXT NOT NULL,
    "lenderReference" TEXT,
    "loanAccountId" TEXT NOT NULL,
    "disbursedToAccountId" TEXT NOT NULL,
    "principal" DECIMAL(14,2) NOT NULL,
    "annualRatePercent" DECIMAL(6,3) NOT NULL,
    "tenureMonths" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "emiAmount" DECIMAL(14,2) NOT NULL,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "disbursementEntryId" TEXT,
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanRepayment" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "installmentNumber" INTEGER NOT NULL,
    "paidDate" TIMESTAMP(3) NOT NULL,
    "totalPaid" DECIMAL(14,2) NOT NULL,
    "principalPortion" DECIMAL(14,2) NOT NULL,
    "interestPortion" DECIMAL(14,2) NOT NULL,
    "paidFromAccountId" TEXT NOT NULL,
    "postedEntryId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanRepayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assetAccountId" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "depreciationRatePercent" DECIMAL(6,3) NOT NULL,
    "salvageValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidFromAccountId" TEXT,
    "sourcePurchaseInvoiceId" TEXT,
    "status" "FixedAssetStatus" NOT NULL DEFAULT 'ACTIVE',
    "postedEntryId" TEXT,
    "disposalDate" TIMESTAMP(3),
    "disposalProceeds" DECIMAL(14,2),
    "disposalEntryId" TEXT,
    "disposalNotes" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DepreciationEntry" (
    "id" TEXT NOT NULL,
    "fixedAssetId" TEXT NOT NULL,
    "financialYear" INTEGER NOT NULL,
    "openingWdv" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "closingWdv" DECIMAL(14,2) NOT NULL,
    "postedEntryId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DepreciationEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashBankTransaction_postedEntryId_key" ON "CashBankTransaction"("postedEntryId");

-- CreateIndex
CREATE INDEX "CashBankTransaction_txnDate_idx" ON "CashBankTransaction"("txnDate");

-- CreateIndex
CREATE INDEX "CashBankTransaction_type_idx" ON "CashBankTransaction"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_loanAccountId_key" ON "Loan"("loanAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_disbursementEntryId_key" ON "Loan"("disbursementEntryId");

-- CreateIndex
CREATE INDEX "Loan_status_idx" ON "Loan"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LoanRepayment_postedEntryId_key" ON "LoanRepayment"("postedEntryId");

-- CreateIndex
CREATE INDEX "LoanRepayment_loanId_idx" ON "LoanRepayment"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanRepayment_loanId_installmentNumber_key" ON "LoanRepayment"("loanId", "installmentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "FixedAsset_sourcePurchaseInvoiceId_key" ON "FixedAsset"("sourcePurchaseInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "FixedAsset_postedEntryId_key" ON "FixedAsset"("postedEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "FixedAsset_disposalEntryId_key" ON "FixedAsset"("disposalEntryId");

-- CreateIndex
CREATE INDEX "FixedAsset_status_idx" ON "FixedAsset"("status");

-- CreateIndex
CREATE INDEX "FixedAsset_assetAccountId_idx" ON "FixedAsset"("assetAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationEntry_postedEntryId_key" ON "DepreciationEntry"("postedEntryId");

-- CreateIndex
CREATE INDEX "DepreciationEntry_fixedAssetId_idx" ON "DepreciationEntry"("fixedAssetId");

-- CreateIndex
CREATE UNIQUE INDEX "DepreciationEntry_fixedAssetId_financialYear_key" ON "DepreciationEntry"("fixedAssetId", "financialYear");

-- AddForeignKey
ALTER TABLE "CashBankTransaction" ADD CONSTRAINT "CashBankTransaction_debitAccountId_fkey" FOREIGN KEY ("debitAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBankTransaction" ADD CONSTRAINT "CashBankTransaction_creditAccountId_fkey" FOREIGN KEY ("creditAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashBankTransaction" ADD CONSTRAINT "CashBankTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_loanAccountId_fkey" FOREIGN KEY ("loanAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_disbursedToAccountId_fkey" FOREIGN KEY ("disbursedToAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRepayment" ADD CONSTRAINT "LoanRepayment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRepayment" ADD CONSTRAINT "LoanRepayment_paidFromAccountId_fkey" FOREIGN KEY ("paidFromAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanRepayment" ADD CONSTRAINT "LoanRepayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_assetAccountId_fkey" FOREIGN KEY ("assetAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_paidFromAccountId_fkey" FOREIGN KEY ("paidFromAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_sourcePurchaseInvoiceId_fkey" FOREIGN KEY ("sourcePurchaseInvoiceId") REFERENCES "PurchaseInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationEntry" ADD CONSTRAINT "DepreciationEntry_fixedAssetId_fkey" FOREIGN KEY ("fixedAssetId") REFERENCES "FixedAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DepreciationEntry" ADD CONSTRAINT "DepreciationEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
