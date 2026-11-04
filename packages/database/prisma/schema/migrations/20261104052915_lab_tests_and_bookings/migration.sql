-- CreateEnum
CREATE TYPE "LabBookingStatus" AS ENUM ('BOOKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LabBookingSource" AS ENUM ('MANUAL', 'VOICE_ASSISTANT', 'PRESCRIPTION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AppointmentSource" ADD VALUE 'VOICE_ASSISTANT';
ALTER TYPE "AppointmentSource" ADD VALUE 'PRESCRIPTION';

-- CreateTable
CREATE TABLE "LabTest" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "sampleType" TEXT NOT NULL DEFAULT 'Blood',
    "reportHours" INTEGER NOT NULL DEFAULT 24,
    "fastingRequired" BOOLEAN NOT NULL DEFAULT false,
    "prepEn" TEXT,
    "prepHi" TEXT,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ActiveStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabBooking" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "facilityId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "status" "LabBookingStatus" NOT NULL DEFAULT 'BOOKED',
    "source" "LabBookingSource" NOT NULL DEFAULT 'MANUAL',
    "collectionAt" TIMESTAMPTZ(3) NOT NULL,
    "homeCollection" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "cancelReason" TEXT,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "fileId" UUID,
    "createdById" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LabBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabBookingItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "labBookingId" UUID NOT NULL,
    "labTestId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabBookingItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabTest_tenantId_facilityId_status_idx" ON "LabTest"("tenantId", "facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LabTest_tenantId_id_key" ON "LabTest"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LabTest_tenantId_facilityId_code_key" ON "LabTest"("tenantId", "facilityId", "code");

-- CreateIndex
CREATE INDEX "LabBooking_tenantId_facilityId_collectionAt_idx" ON "LabBooking"("tenantId", "facilityId", "collectionAt");

-- CreateIndex
CREATE INDEX "LabBooking_tenantId_patientId_collectionAt_idx" ON "LabBooking"("tenantId", "patientId", "collectionAt");

-- CreateIndex
CREATE UNIQUE INDEX "LabBooking_tenantId_id_key" ON "LabBooking"("tenantId", "id");

-- CreateIndex
CREATE INDEX "LabBookingItem_tenantId_labBookingId_idx" ON "LabBookingItem"("tenantId", "labBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "LabBookingItem_labBookingId_labTestId_key" ON "LabBookingItem"("labBookingId", "labTestId");

-- AddForeignKey
ALTER TABLE "LabTest" ADD CONSTRAINT "LabTest_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabBooking" ADD CONSTRAINT "LabBooking_tenantId_facilityId_fkey" FOREIGN KEY ("tenantId", "facilityId") REFERENCES "Facility"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabBooking" ADD CONSTRAINT "LabBooking_tenantId_patientId_fkey" FOREIGN KEY ("tenantId", "patientId") REFERENCES "Patient"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabBookingItem" ADD CONSTRAINT "LabBookingItem_labBookingId_fkey" FOREIGN KEY ("labBookingId") REFERENCES "LabBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabBookingItem" ADD CONSTRAINT "LabBookingItem_labTestId_fkey" FOREIGN KEY ("labTestId") REFERENCES "LabTest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== Hand-written invariants =====
-- Lab bookings: a booking is only ever BOOKED -> CANCELLED (with a reason); its items never change; nothing is deleted.
CREATE OR REPLACE FUNCTION medos_lab_booking_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" <> OLD."tenantId" OR NEW."facilityId" <> OLD."facilityId" OR NEW."patientId" <> OLD."patientId"
     OR NEW."totalAmount" <> OLD."totalAmount" OR NEW.source <> OLD.source OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'A lab booking cannot be rewritten' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'BOOKED' AND NEW.status = 'CANCELLED') THEN
    RAISE EXCEPTION 'Invalid lab booking status transition' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'CANCELLED' AND NEW."cancelReason" IS NULL THEN
    RAISE EXCEPTION 'Cancellation requires a reason' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'CANCELLED' AND (NEW."collectionAt" <> OLD."collectionAt" OR NEW."homeCollection" <> OLD."homeCollection") THEN
    RAISE EXCEPTION 'A cancelled lab booking cannot be changed' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER lab_booking_guard BEFORE UPDATE ON "LabBooking" FOR EACH ROW EXECUTE FUNCTION medos_lab_booking_guard();
CREATE TRIGGER lab_booking_no_delete BEFORE DELETE ON "LabBooking" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();
CREATE TRIGGER lab_booking_item_immutable BEFORE UPDATE OR DELETE ON "LabBookingItem" FOR EACH ROW EXECUTE FUNCTION medos_forbid_mutation();

ALTER TABLE "LabBooking" ADD CONSTRAINT lab_booking_total_nonneg CHECK ("totalAmount" >= 0);
ALTER TABLE "LabBookingItem" ADD CONSTRAINT lab_booking_item_price_nonneg CHECK (price >= 0);
ALTER TABLE "LabTest" ADD CONSTRAINT lab_test_price_nonneg CHECK (price >= 0);

