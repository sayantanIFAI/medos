-- AlterEnum
ALTER TYPE "AppointmentSource" ADD VALUE 'VOICE_BOT';

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "externalRef" TEXT;

-- AlterTable
ALTER TABLE "Practitioner" ADD COLUMN     "externalRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_tenantId_externalRef_key" ON "Appointment"("tenantId", "externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "Practitioner_tenantId_externalRef_key" ON "Practitioner"("tenantId", "externalRef");
