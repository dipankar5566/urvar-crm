-- CreateEnum
CREATE TYPE "CallMode" AS ENUM ('HUMAN', 'AI_ASSISTED', 'AI_AUTONOMOUS');

-- CreateEnum
CREATE TYPE "CallSentiment" AS ENUM ('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'ESCALATED');

-- AlterEnum
ALTER TYPE "CallOutcome" ADD VALUE 'TRANSFERRED_TO_HUMAN';

-- DropForeignKey
ALTER TABLE "Call" DROP CONSTRAINT "Call_userId_fkey";

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "aiAgentVersion" TEXT,
ADD COLUMN     "aiIntentTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "aiSentiment" "CallSentiment",
ADD COLUMN     "aiSummary" TEXT,
ADD COLUMN     "callMode" "CallMode" NOT NULL DEFAULT 'HUMAN',
ADD COLUMN     "followUpId" TEXT,
ADD COLUMN     "transcript" JSONB,
ADD COLUMN     "transferredToUserId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "doNotCall" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "doNotCallReason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Call_followUpId_key" ON "Call"("followUpId");

-- CreateIndex
CREATE INDEX "Call_callMode_idx" ON "Call"("callMode");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_transferredToUserId_fkey" FOREIGN KEY ("transferredToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_followUpId_fkey" FOREIGN KEY ("followUpId") REFERENCES "FollowUp"("id") ON DELETE SET NULL ON UPDATE CASCADE;
