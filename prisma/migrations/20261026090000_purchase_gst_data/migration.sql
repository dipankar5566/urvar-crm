-- CreateEnum
CREATE TYPE "ItcEligibility" AS ENUM ('INPUTS', 'CAPITAL_GOODS', 'INPUT_SERVICES', 'INELIGIBLE');

-- AlterTable
ALTER TABLE "PurchaseInvoice" ADD COLUMN     "cessAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "isReverseCharge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "itcEligibility" "ItcEligibility" NOT NULL DEFAULT 'INPUTS',
ADD COLUMN     "placeOfSupply" TEXT,
ADD COLUMN     "supplierGstin" TEXT;

-- AlterTable
ALTER TABLE "PurchaseInvoiceItem" ADD COLUMN     "cessAmount" DECIMAL(14,2),
ADD COLUMN     "cgstAmount" DECIMAL(14,2),
ADD COLUMN     "hsnCode" TEXT,
ADD COLUMN     "igstAmount" DECIMAL(14,2),
ADD COLUMN     "sgstAmount" DECIMAL(14,2),
ADD COLUMN     "taxRatePercent" DECIMAL(5,2),
ADD COLUMN     "taxableValue" DECIMAL(14,2);
