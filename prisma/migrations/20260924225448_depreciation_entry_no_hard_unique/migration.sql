-- DropIndex
DROP INDEX "DepreciationEntry_fixedAssetId_financialYear_key";

-- CreateIndex
CREATE INDEX "DepreciationEntry_fixedAssetId_financialYear_idx" ON "DepreciationEntry"("fixedAssetId", "financialYear");
