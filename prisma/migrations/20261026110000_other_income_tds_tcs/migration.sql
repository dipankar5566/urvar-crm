-- CreateEnum
CREATE TYPE "OtherIncomeStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "JournalSourceType" ADD VALUE 'OTHER_INCOME';

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "tdsCaptureEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "tdsDeducted" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SupplierPayment" ADD COLUMN     "tdsDeducted" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "OtherIncome" (
    "id" TEXT NOT NULL,
    "incomeNumber" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "incomeDate" TIMESTAMP(3) NOT NULL,
    "categoryAccountId" TEXT NOT NULL,
    "payerName" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "isGstApplicable" BOOLEAN NOT NULL DEFAULT false,
    "subtotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sgstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igstAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "roundOff" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "method" "PaymentMethod" NOT NULL,
    "depositAccountId" TEXT NOT NULL,
    "status" "OtherIncomeStatus" NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "postedEntryId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtherIncome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtherIncomeItem" (
    "id" TEXT NOT NULL,
    "otherIncomeId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,2) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "taxRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "lineNumber" INTEGER NOT NULL,

    CONSTRAINT "OtherIncomeItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OtherIncome_incomeNumber_key" ON "OtherIncome"("incomeNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OtherIncome_postedEntryId_key" ON "OtherIncome"("postedEntryId");

-- CreateIndex
CREATE INDEX "OtherIncome_status_idx" ON "OtherIncome"("status");

-- CreateIndex
CREATE INDEX "OtherIncome_incomeDate_idx" ON "OtherIncome"("incomeDate");

-- CreateIndex
CREATE INDEX "OtherIncome_categoryAccountId_idx" ON "OtherIncome"("categoryAccountId");

-- CreateIndex
CREATE INDEX "OtherIncomeItem_otherIncomeId_idx" ON "OtherIncomeItem"("otherIncomeId");

-- AddForeignKey
ALTER TABLE "OtherIncome" ADD CONSTRAINT "OtherIncome_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherIncome" ADD CONSTRAINT "OtherIncome_categoryAccountId_fkey" FOREIGN KEY ("categoryAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherIncome" ADD CONSTRAINT "OtherIncome_depositAccountId_fkey" FOREIGN KEY ("depositAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherIncome" ADD CONSTRAINT "OtherIncome_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherIncome" ADD CONSTRAINT "OtherIncome_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtherIncomeItem" ADD CONSTRAINT "OtherIncomeItem_otherIncomeId_fkey" FOREIGN KEY ("otherIncomeId") REFERENCES "OtherIncome"("id") ON DELETE CASCADE ON UPDATE CASCADE;
