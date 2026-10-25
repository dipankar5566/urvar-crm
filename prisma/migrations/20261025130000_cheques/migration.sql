-- CreateEnum
CREATE TYPE "ChequeDirection" AS ENUM ('RECEIVED', 'ISSUED');

-- CreateEnum
CREATE TYPE "ChequeStatus" AS ENUM ('OPEN', 'DEPOSITED', 'CLEARED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "JournalSourceType" ADD VALUE 'CHEQUE_TRANSFER';

-- CreateTable
CREATE TABLE "Cheque" (
    "id" TEXT NOT NULL,
    "direction" "ChequeDirection" NOT NULL,
    "status" "ChequeStatus" NOT NULL DEFAULT 'OPEN',
    "chequeNumber" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "chequeDate" TIMESTAMP(3) NOT NULL,
    "receiptId" TEXT,
    "supplierPaymentId" TEXT,
    "bankLedgerAccountId" TEXT,
    "transferDate" TIMESTAMP(3),
    "transferEntryId" TEXT,
    "transferRevision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cheque_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cheque_receiptId_key" ON "Cheque"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "Cheque_supplierPaymentId_key" ON "Cheque"("supplierPaymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Cheque_transferEntryId_key" ON "Cheque"("transferEntryId");

-- CreateIndex
CREATE INDEX "Cheque_status_idx" ON "Cheque"("status");

-- CreateIndex
CREATE INDEX "Cheque_direction_idx" ON "Cheque"("direction");

-- AddForeignKey
ALTER TABLE "Cheque" ADD CONSTRAINT "Cheque_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cheque" ADD CONSTRAINT "Cheque_supplierPaymentId_fkey" FOREIGN KEY ("supplierPaymentId") REFERENCES "SupplierPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cheque" ADD CONSTRAINT "Cheque_bankLedgerAccountId_fkey" FOREIGN KEY ("bankLedgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
