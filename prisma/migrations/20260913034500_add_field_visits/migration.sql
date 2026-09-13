-- AlterEnum
ALTER TYPE "FileCategory" ADD VALUE 'FIELD_VISIT_PHOTO';

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "relatedFieldVisitId" TEXT;

-- CreateTable
CREATE TABLE "FieldVisit" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "customerId" TEXT,
    "userId" TEXT NOT NULL,
    "checkInAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkInLat" DOUBLE PRECISION NOT NULL,
    "checkInLng" DOUBLE PRECISION NOT NULL,
    "checkInAccuracy" DOUBLE PRECISION,
    "checkOutAt" TIMESTAMP(3),
    "checkOutLat" DOUBLE PRECISION,
    "checkOutLng" DOUBLE PRECISION,
    "checkOutAccuracy" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FieldVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FieldVisit_leadId_idx" ON "FieldVisit"("leadId");

-- CreateIndex
CREATE INDEX "FieldVisit_customerId_idx" ON "FieldVisit"("customerId");

-- CreateIndex
CREATE INDEX "FieldVisit_userId_checkInAt_idx" ON "FieldVisit"("userId", "checkInAt");

-- CreateIndex
CREATE INDEX "File_relatedFieldVisitId_idx" ON "File"("relatedFieldVisitId");

-- AddForeignKey
ALTER TABLE "File" ADD CONSTRAINT "File_relatedFieldVisitId_fkey" FOREIGN KEY ("relatedFieldVisitId") REFERENCES "FieldVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldVisit" ADD CONSTRAINT "FieldVisit_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldVisit" ADD CONSTRAINT "FieldVisit_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FieldVisit" ADD CONSTRAINT "FieldVisit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
