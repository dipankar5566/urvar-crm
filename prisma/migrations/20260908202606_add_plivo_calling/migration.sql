-- AlterEnum
ALTER TYPE "CallProvider" ADD VALUE 'PLIVO';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "plivoEndpointId" TEXT,
ADD COLUMN     "plivoPasswordEncrypted" TEXT,
ADD COLUMN     "plivoUsername" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_plivoUsername_key" ON "User"("plivoUsername");
