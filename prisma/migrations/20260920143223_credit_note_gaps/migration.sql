-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SalesInvoiceItem" ADD COLUMN     "quantityCredited" DECIMAL(12,2) NOT NULL DEFAULT 0;
