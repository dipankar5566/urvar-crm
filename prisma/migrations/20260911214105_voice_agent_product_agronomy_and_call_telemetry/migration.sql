-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "aiMetrics" JSONB,
ADD COLUMN     "aiStructured" JSONB;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "applicationMethod" TEXT,
ADD COLUMN     "availability" TEXT,
ADD COLUMN     "benefits" TEXT,
ADD COLUMN     "dosage" TEXT,
ADD COLUMN     "nutrientContent" TEXT,
ADD COLUMN     "objectionNotes" TEXT,
ADD COLUMN     "problemSolved" TEXT,
ADD COLUMN     "targetCrops" TEXT;
