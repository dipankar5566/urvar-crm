-- CreateEnum
CREATE TYPE "CallProvider" AS ENUM ('MANUAL', 'TWILIO');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "fromNumber" TEXT,
ADD COLUMN     "provider" "CallProvider" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "providerCallSid" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "recordingSid" TEXT,
ADD COLUMN     "recordingUrl" TEXT,
ADD COLUMN     "toNumber" TEXT,
ALTER COLUMN "outcome" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Call_providerCallSid_key" ON "Call"("providerCallSid");

