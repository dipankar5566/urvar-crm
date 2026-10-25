-- CreateEnum
CREATE TYPE "LoanTransactionType" AS ENUM ('PROCESSING_FEE', 'CHARGES', 'TOP_UP');

-- AlterEnum
ALTER TYPE "JournalSourceType" ADD VALUE 'LOAN_TRANSACTION';

-- CreateTable
CREATE TABLE "LoanTransaction" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "type" "LoanTransactionType" NOT NULL,
    "txnDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "accountId" TEXT NOT NULL,
    "notes" TEXT,
    "postedEntryId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoanTransaction_postedEntryId_key" ON "LoanTransaction"("postedEntryId");

-- CreateIndex
CREATE INDEX "LoanTransaction_loanId_idx" ON "LoanTransaction"("loanId");

-- AddForeignKey
ALTER TABLE "LoanTransaction" ADD CONSTRAINT "LoanTransaction_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanTransaction" ADD CONSTRAINT "LoanTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanTransaction" ADD CONSTRAINT "LoanTransaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
