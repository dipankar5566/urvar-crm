-- DropIndex
DROP INDEX "LoanRepayment_loanId_installmentNumber_key";

-- CreateIndex
CREATE INDEX "LoanRepayment_loanId_installmentNumber_idx" ON "LoanRepayment"("loanId", "installmentNumber");
