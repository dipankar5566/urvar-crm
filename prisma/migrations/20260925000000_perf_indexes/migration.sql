-- CreateIndex
CREATE INDEX "Call_calledAt_idx" ON "Call"("calledAt");

-- CreateIndex
CREATE INDEX "Customer_phone_idx" ON "Customer"("phone");

-- CreateIndex
CREATE INDEX "FollowUp_status_dueAt_idx" ON "FollowUp"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Lead_phone_idx" ON "Lead"("phone");

-- CreateIndex
CREATE INDEX "Quotation_sentAt_idx" ON "Quotation"("sentAt");

-- CreateIndex
CREATE INDEX "Quotation_createdAt_idx" ON "Quotation"("createdAt");
