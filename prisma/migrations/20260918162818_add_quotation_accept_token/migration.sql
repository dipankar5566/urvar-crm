-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN     "acceptToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_acceptToken_key" ON "Quotation"("acceptToken");
