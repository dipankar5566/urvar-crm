-- CreateEnum
CREATE TYPE "StockValuationStatus" AS ENUM ('DRAFT', 'POSTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "SalesInvoiceItem" ADD COLUMN     "estimatedCostAmount" DECIMAL(14,2),
ADD COLUMN     "estimatedUnitCost" DECIMAL(14,4);

-- CreateTable
CREATE TABLE "StockValuation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "valuationDate" TIMESTAMP(3) NOT NULL,
    "totalValue" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "status" "StockValuationStatus" NOT NULL DEFAULT 'DRAFT',
    "postedEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockValuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockValuationLine" (
    "id" TEXT NOT NULL,
    "valuationId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantityOnHand" DECIMAL(12,2) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "costSource" TEXT NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "StockValuationLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockValuation_periodId_key" ON "StockValuation"("periodId");

-- CreateIndex
CREATE UNIQUE INDEX "StockValuation_postedEntryId_key" ON "StockValuation"("postedEntryId");

-- CreateIndex
CREATE INDEX "StockValuation_companyId_idx" ON "StockValuation"("companyId");

-- CreateIndex
CREATE INDEX "StockValuation_status_idx" ON "StockValuation"("status");

-- CreateIndex
CREATE INDEX "StockValuationLine_valuationId_idx" ON "StockValuationLine"("valuationId");

-- CreateIndex
CREATE UNIQUE INDEX "StockValuationLine_valuationId_productId_key" ON "StockValuationLine"("valuationId", "productId");

-- AddForeignKey
ALTER TABLE "StockValuation" ADD CONSTRAINT "StockValuation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockValuation" ADD CONSTRAINT "StockValuation_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "FinancialPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockValuation" ADD CONSTRAINT "StockValuation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockValuationLine" ADD CONSTRAINT "StockValuationLine_valuationId_fkey" FOREIGN KEY ("valuationId") REFERENCES "StockValuation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockValuationLine" ADD CONSTRAINT "StockValuationLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
