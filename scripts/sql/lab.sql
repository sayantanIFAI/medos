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
