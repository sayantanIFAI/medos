import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt, round2 } from "../billing/billing.domain";
import { InvoicesService } from "../billing/invoices.service";
import { LedgerService } from "../billing/ledger.service";
import { amount } from "../billing/money.schema";
import { AllergiesService, allergenKey, findAllergyMatches } from "../clinical/allergies.service";
import { NumberingService } from "../numbering/numbering.service";
import { StockService } from "./stock.service";

const uuid = z.string().uuid();
const method = z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "OTHER"]);

export const dispenseSchema = z.object({
  patientId: uuid,
  medicationOrderId: uuid.optional(),
  items: z.array(z.object({
    medicationOrderItemId: uuid.optional(), medicineId: uuid, quantity: z.number().int().min(1).max(100_000), batchId: uuid.optional(),
  }).strict()).min(1).max(30),
  payments: z.array(z.object({ method, amount: amount({ positive: true }), reference: z.string().trim().min(4).max(60).optional() }).strict()).max(6).optional(),
  acknowledgeAllergyWarnings: z.boolean().optional(),
  /** IPD patients: add the medicines to the admission bill instead of invoicing at the counter. */
  chargeToAdmission: z.boolean().optional(),
  notes: z.string().trim().max(300).optional(),
}).strict().refine((v) => !(v.chargeToAdmission && v.payments?.length), { message: "Payment is taken at discharge for charges added to an admission", path: ["payments"] });

export const dispenseReturnSchema = z.object({
  reason: z.string().trim().min(5).max(240),
  items: z.array(z.object({ dispenseItemId: uuid, quantity: z.number().int().min(1).max(100_000) }).strict()).min(1).max(30),
}).strict();

export const suggestSchema = z.object({ quantity: z.coerce.number().int().min(1).max(100_000) }).strict();
export const queueQuerySchema = z.object({
  q: z.string().trim().min(2).max(60).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(25),
}).strict();
export const dispenseListSchema = z.object({ patientId: uuid.optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();

const GENERIC_MATCH_MIN = 3;
/** A dispensed medicine must contain (or be contained in) the prescribed generic name: guards against dispensing the wrong drug. */
export function genericMatches(prescribed: string, medicineGeneric: string): boolean {
  const a = allergenKey(prescribed);
  const b = allergenKey(medicineGeneric);
  return a.length >= GENERIC_MATCH_MIN && b.length >= GENERIC_MATCH_MIN && (a.includes(b) || b.includes(a));
}

@Injectable()
export class DispensingService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly stock: StockService,
    private readonly numbering: NumberingService, private readonly idempotency: IdempotencyService, private readonly invoices: InvoicesService,
    private readonly ledger: LedgerService, private readonly allergies: AllergiesService,
  ) {}

  // ───── prescription queue ─────

  /** Signed prescriptions with something left to dispense, oldest first. */
  async queue(ctx: RequestContext, q: z.infer<typeof queueQuerySchema>) {
    const where: Prisma.MedicationOrderWhereInput = {
      tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "SIGNED",
      items: { some: { status: "ACTIVE", OR: [{ quantity: null, dispensedQuantity: 0 }, { quantity: { gt: 0 } }] } },
      ...(q.q ? { OR: [{ orderNumber: { contains: q.q, mode: "insensitive" } }, { patient: { searchName: { contains: q.q.toLowerCase() } } }, { patient: { identifiers: { some: { value: { contains: q.q, mode: "insensitive" } } } } }] } : {}),
    };
    const rows = await this.prisma.medicationOrder.findMany({
      where, orderBy: { signedAt: "asc" }, take: 500,
      include: { items: { orderBy: { lineNo: "asc" } }, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } } },
    });
    const open = rows.filter((o) => o.items.some((i) => i.status === "ACTIVE" && (i.quantity === null ? i.dispensedQuantity === 0 : i.dispensedQuantity < i.quantity)));
    const page = open.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
    const doctorIds = [...new Set(page.map((o) => o.orderedById))];
    const docs = await this.prisma.practitioner.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: { in: doctorIds } }, select: { userId: true, displayName: true } });
    const items = await Promise.all(page.map(async (o) => {
      const warnings = findAllergyMatches(await this.allergies.activeForMatching(this.prisma, ctx, o.patientId), o.items.flatMap((i) => [i.genericName, ...(i.brandName ? [i.brandName] : [])]));
      return {
        id: o.id, orderNumber: o.orderNumber, signedAt: o.signedAt, patientId: o.patientId, encounterId: o.encounterId,
        patientName: [o.patient.firstName, o.patient.lastName].filter(Boolean).join(" "), mrn: o.patient.identifiers[0]?.value ?? null,
        doctorName: docs.find((d) => d.userId === o.orderedById)?.displayName ?? null,
        status: o.items.some((i) => i.dispensedQuantity > 0) ? "PARTIAL" : "PENDING", allergyWarnings: warnings,
        items: o.items.map((i) => ({
          id: i.id, lineNo: i.lineNo, medicineId: i.medicineId, genericName: i.genericName, brandName: i.brandName, strength: i.strength, dosage: i.dosage, route: i.route, frequency: i.frequency,
          frequencyText: i.frequencyText, durationDays: i.durationDays, quantity: i.quantity, dispensedQuantity: i.dispensedQuantity, status: i.status,
          remaining: i.status !== "ACTIVE" ? 0 : i.quantity === null ? null : i.quantity - i.dispensedQuantity,
        })),
      };
    }));
    return { items, total: open.length };
  }

  /** FEFO preview without locking: which batches would be used for this quantity. */
  async suggest(ctx: RequestContext, medicineId: string, quantity: number) {
    const m = await this.prisma.medicine.findFirst({ where: { id: medicineId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true, brandName: true, strength: true } });
    if (!m) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const alloc = await this.stock.allocateFefo(this.prisma, ctx, medicineId, quantity, { lock: false });
    return alloc.map((a) => ({ batchId: a.batchId, batchNo: a.batchNo, expiryDate: a.expiryDate.toISOString().slice(0, 10), quantity: a.quantity, unitPrice: fmt(a.sellingPrice), mrp: fmt(a.mrp) }));
  }

  // ───── dispense ─────

  async dispense(ctx: RequestContext, input: z.infer<typeof dispenseSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for dispensing", 400);
    if (input.payments?.length && !ctx.permissions.has("PAYMENT_CREATE")) throw new DomainError("FORBIDDEN", "You do not have permission to take payments", 403);
    return this.idempotency.run(ctx.tenantId, "DISPENSE", key, input, async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: input.patientId, tenantId: ctx.tenantId, status: "ACTIVE" }, select: { id: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);

      const medicines = await tx.medicine.findMany({ where: { id: { in: [...new Set(input.items.map((i) => i.medicineId))] }, tenantId: ctx.tenantId, status: "ACTIVE" } });
      const medById = new Map(medicines.map((m) => [m.id, m]));
      for (const [i, it] of input.items.entries()) if (!medById.has(it.medicineId)) throw new DomainError("VALIDATION_FAILED", "A medicine does not exist or is inactive", 400, [{ path: `items.${i}.medicineId`, message: "Unknown medicine" }]);

      // Prescription linkage and over-dispensing guard
      let order: Prisma.MedicationOrderGetPayload<{ include: { items: true } }> | null = null;
      if (input.medicationOrderId) {
        order = await tx.medicationOrder.findFirst({ where: { id: input.medicationOrderId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { items: true } });
        if (!order) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        if (order.status !== "SIGNED") throw new DomainError("INVALID_STATE", "Only signed prescriptions can be dispensed", 409);
        if (order.patientId !== input.patientId) throw new DomainError("VALIDATION_FAILED", "The prescription belongs to a different patient", 400);
      }
      for (const [i, it] of input.items.entries()) {
        if (!order && it.medicationOrderItemId) throw new DomainError("VALIDATION_FAILED", "Prescription items need a prescription", 400, [{ path: `items.${i}.medicationOrderItemId`, message: "No prescription selected" }]);
        if (order && !it.medicationOrderItemId) throw new DomainError("VALIDATION_FAILED", "Select the prescription line this medicine fulfils", 400, [{ path: `items.${i}.medicationOrderItemId`, message: "Required" }]);
        if (order && it.medicationOrderItemId) {
          const oi = order.items.find((x) => x.id === it.medicationOrderItemId);
          if (!oi) throw new DomainError("VALIDATION_FAILED", "A line does not belong to this prescription", 400, [{ path: `items.${i}.medicationOrderItemId`, message: "Unknown prescription line" }]);
          if (oi.status !== "ACTIVE") throw new DomainError("INVALID_STATE", `${oi.genericName} was stopped by the doctor`, 409);
          const med = medById.get(it.medicineId)!;
          if (!genericMatches(oi.genericName, med.genericName) && !genericMatches(oi.brandName ?? "", med.brandName)) {
            throw new DomainError("VALIDATION_FAILED", `${med.brandName} does not match the prescribed ${oi.genericName}`, 400, [{ path: `items.${i}.medicineId`, message: "Medicine does not match the prescription" }]);
          }
        }
      }

      // Allergy cross-check against what is actually being handed over
      const names = input.items.flatMap((it) => { const m = medById.get(it.medicineId)!; return [m.genericName, m.brandName]; });
      const warnings = findAllergyMatches(await this.allergies.activeForMatching(tx, ctx, input.patientId), names);
      if (warnings.length && !input.acknowledgeAllergyWarnings) throw new DomainError("ALLERGY_CONFLICT", "A medicine matches a recorded allergy. Review it, then confirm to continue.", 409, { allergyWarnings: warnings });

      // Lock + update prescription lines first (fixed order), so a concurrent dispense of the same line fails cleanly.
      const perLine = new Map<string, number>();
      for (const it of input.items) if (it.medicationOrderItemId) perLine.set(it.medicationOrderItemId, (perLine.get(it.medicationOrderItemId) ?? 0) + it.quantity);
      for (const [lineId, n] of [...perLine.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const res = await tx.$executeRaw`
          UPDATE "MedicationOrderItem" SET "dispensedQuantity" = "dispensedQuantity" + ${n}
          WHERE id = ${lineId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND status = 'ACTIVE' AND (quantity IS NULL OR "dispensedQuantity" + ${n} <= quantity)`;
        if (res !== 1) throw new DomainError("INSUFFICIENT_STOCK", "That quantity exceeds what is left to dispense on the prescription", 409, { lineId });
      }

      // Allocate batches (FEFO) in medicine-id order so lock order is globally consistent.
      const dispenseNumber = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "PHARMACY_RECEIPT");
      const header = { id: randomUUID() };
      const lines: { id: string; medicationOrderItemId: string | null; medicineId: string; batchId: string; quantity: number; unitPrice: Decimal; gst: Decimal; total: Decimal; label: string }[] = [];
      for (const [, it] of [...input.items.entries()].sort(([, a], [, b]) => a.medicineId.localeCompare(b.medicineId))) {
        const med = medById.get(it.medicineId)!;
        const allocations = it.batchId ? await this.explicitBatch(tx, ctx, it.medicineId, it.batchId, it.quantity) : await this.stock.allocateFefo(tx, ctx, it.medicineId, it.quantity, { lock: true });
        for (const a of allocations) {
          await this.stock.move(tx, ctx, { batchId: a.batchId, medicineId: it.medicineId, type: "SALE", direction: "OUT", quantity: a.quantity, sourceType: "DISPENSE", sourceId: header.id });
          const price = new Decimal(a.sellingPrice);
          lines.push({ id: randomUUID(), medicationOrderItemId: it.medicationOrderItemId ?? null, medicineId: it.medicineId, batchId: a.batchId, quantity: a.quantity, unitPrice: price, gst: new Decimal(med.gstPercent.toString()), total: round2(price.times(a.quantity)), label: [med.brandName, med.strength].filter(Boolean).join(" ") });
        }
      }
      // Medicine prices are MRP-inclusive of GST: the bill is exactly qty x selling price; the GST component is recorded for reporting.
      const total = lines.reduce((a, l) => a.plus(l.total), new Decimal(0));
      const gstIncluded = lines.reduce((a, l) => a.plus(round2(l.total.times(l.gst).div(new Decimal(100).plus(l.gst)))), new Decimal(0));
      let invoice: { id: string; invoiceNumber: string } | null = null;
      if (input.chargeToAdmission) {
        const adm = await tx.admission.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, status: "ADMITTED" }, select: { id: true, finalInvoiceId: true } });
        if (!adm) throw new DomainError("INVALID_STATE", "The patient is not currently admitted, so medicines cannot be charged to an admission", 409);
        if (adm.finalInvoiceId) throw new DomainError("INVALID_STATE", "The final bill has already been issued; sell the medicines at the counter instead", 409);
        await tx.dispense.create({
          data: { id: header.id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, medicationOrderId: order?.id ?? null, encounterId: order?.encounterId ?? null, dispenseNumber, invoiceId: null, subtotal: total.minus(gstIncluded).toFixed(2), taxTotal: gstIncluded.toFixed(2), total: total.toFixed(2), notes: input.notes ?? null, dispensedById: ctx.userId },
        });
        await tx.dispenseItem.createMany({
          data: lines.map((l, idx) => ({ id: l.id, tenantId: ctx.tenantId, dispenseId: header.id, lineNo: idx + 1, medicationOrderItemId: l.medicationOrderItemId, medicineId: l.medicineId, batchId: l.batchId, quantity: l.quantity, unitPrice: l.unitPrice.toFixed(2), taxPercent: l.gst.toFixed(2), lineTotal: l.total.toFixed(2) })),
        });
        await tx.charge.createMany({
          data: lines.map((l) => ({ tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, admissionId: adm.id, type: "MEDICINE" as const, description: `${l.label} x${l.quantity} (${dispenseNumber})`, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toFixed(2), taxPercent: "0", sourceKey: `DISPENSE_ITEM:${l.id}`, chargedById: ctx.userId })),
        });
      } else {
        const created = await this.invoices.createIssuedFromSource(tx, ctx, {
          patientId: input.patientId, encounterId: order?.encounterId ?? null, kind: "PHARMACY", notes: `Pharmacy ${dispenseNumber}`,
          lines: lines.map((l) => ({ description: l.label, quantity: new Decimal(l.quantity), unitPrice: l.unitPrice, taxPercent: new Decimal(0), sourceType: "DISPENSE", sourceId: l.id })),
        });
        invoice = { id: created.id, invoiceNumber: created.invoiceNumber };
        await tx.dispense.create({
          data: { id: header.id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: input.patientId, medicationOrderId: order?.id ?? null, encounterId: order?.encounterId ?? null, dispenseNumber, invoiceId: invoice.id, subtotal: total.minus(gstIncluded).toFixed(2), taxTotal: gstIncluded.toFixed(2), total: total.toFixed(2), notes: input.notes ?? null, dispensedById: ctx.userId },
        });
        await tx.dispenseItem.createMany({
          data: lines.map((l, idx) => ({ id: l.id, tenantId: ctx.tenantId, dispenseId: header.id, lineNo: idx + 1, medicationOrderItemId: l.medicationOrderItemId, medicineId: l.medicineId, batchId: l.batchId, quantity: l.quantity, unitPrice: l.unitPrice.toFixed(2), taxPercent: l.gst.toFixed(2), lineTotal: l.total.toFixed(2) })),
        });
      }

      let receipt: { receiptNumber: string; total: string } | null = null;
      if (input.payments?.length && invoice) {
        const inv = await this.ledger.lock(tx, ctx, invoice.id);
        const r = await this.ledger.receive(tx, ctx, inv, input.payments.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference ?? null })));
        receipt = { receiptNumber: r.receiptNumber, total: fmt(r.total) };
      }
      await this.audit.record(tx, actorOf(ctx), { action: "PHARMACY_DISPENSED", entityType: "Dispense", entityId: header.id, metadata: { dispenseNumber, lines: lines.length, total: fmt(total), orderNumber: order?.orderNumber ?? null, invoiceNumber: invoice?.invoiceNumber ?? null, chargedToAdmission: !!input.chargeToAdmission } });
      if (warnings.length) await this.audit.record(tx, actorOf(ctx), { action: "DISPENSE_ALLERGY_ACKNOWLEDGED", entityType: "Dispense", entityId: header.id, metadata: { allergies: warnings.map((w) => w.allergen) } });
      return { dispense: await this.view(tx, ctx, header.id), receipt };
    });
  }

  // ───── returns ─────

  /** Patient returns: stock goes back via PATIENT_RETURN; the value is credited on the pharmacy invoice (refund is a cashier action). */
  async returnItems(ctx: RequestContext, dispenseId: string, input: z.infer<typeof dispenseReturnSchema>, key: string | undefined) {
    if (!key) throw new DomainError("VALIDATION_FAILED", "An Idempotency-Key header is required for returns", 400);
    return this.idempotency.run(ctx.tenantId, `DISPENSE_RETURN:${dispenseId}`, key, input, async (tx) => {
      const d = await tx.dispense.findFirst({ where: { id: dispenseId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { items: true } });
      if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (!d.invoiceId) return this.returnChargedItems(tx, ctx, d, input, dispenseId);
      const merged = new Map<string, number>();
      for (const i of input.items) merged.set(i.dispenseItemId, (merged.get(i.dispenseItemId) ?? 0) + i.quantity);
      const inv = await this.ledger.lock(tx, ctx, d.invoiceId);
      let value = new Decimal(0);
      for (const [itemId, quantity] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const item = d.items.find((x) => x.id === itemId);
        if (!item) throw new DomainError("VALIDATION_FAILED", "An item does not belong to this dispense", 400, [{ path: "items", message: "Unknown dispense item" }]);
        const cap = await tx.dispenseItem.updateMany({ where: { id: itemId, tenantId: ctx.tenantId, returnedQuantity: { lte: item.quantity - quantity } }, data: { returnedQuantity: { increment: quantity } } });
        if (cap.count !== 1) throw new DomainError("INVALID_AMOUNT", `Only ${item.quantity - item.returnedQuantity} unit(s) of this item can still be returned`, 409);
        await this.stock.move(tx, ctx, { batchId: item.batchId, medicineId: item.medicineId, type: "PATIENT_RETURN", direction: "IN", quantity, sourceType: "DISPENSE_RETURN", sourceId: dispenseId, reason: input.reason });
        value = value.plus(round2(new Decimal(item.unitPrice.toString()).times(quantity)));
      }
      const credit = await this.ledger.credit(tx, ctx, inv, { amount: value, reason: `Pharmacy return: ${input.reason}` }, { allowFull: true });
      const after = await tx.dispenseItem.findMany({ where: { tenantId: ctx.tenantId, dispenseId } });
      const status = after.every((i) => i.returnedQuantity === i.quantity) ? "RETURNED" : "PARTIALLY_RETURNED";
      await tx.dispense.updateMany({ where: { id: dispenseId, tenantId: ctx.tenantId }, data: { status } });
      await this.audit.record(tx, actorOf(ctx), { action: "PHARMACY_RETURN", entityType: "Dispense", entityId: dispenseId, metadata: { value: fmt(value), reason: input.reason, creditNoteNumber: credit.row.creditNoteNumber, status } });
      return { creditNoteNumber: credit.row.creditNoteNumber, creditedAmount: fmt(value), dispense: await this.view(tx, ctx, dispenseId) };
    });
  }

  /** Return of medicines that were charged to an admission: restock, then void and re-post the (still unbilled) charge for what remains. */
  private async returnChargedItems(tx: Db, ctx: RequestContext, d: Prisma.DispenseGetPayload<{ include: { items: true } }>, input: z.infer<typeof dispenseReturnSchema>, dispenseId: string) {
    const merged = new Map<string, number>();
    for (const i of input.items) merged.set(i.dispenseItemId, (merged.get(i.dispenseItemId) ?? 0) + i.quantity);
    for (const [itemId, quantity] of [...merged.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const item = d.items.find((x) => x.id === itemId);
      if (!item) throw new DomainError("VALIDATION_FAILED", "An item does not belong to this dispense", 400, [{ path: "items", message: "Unknown dispense item" }]);
      const live = await tx.charge.findFirst({ where: { tenantId: ctx.tenantId, sourceKey: { startsWith: `DISPENSE_ITEM:${itemId}` }, status: "PENDING" } });
      if (!live) throw new DomainError("INVALID_STATE", "These medicines are already on an invoice. Raise a credit note through billing.", 409);
      const cap = await tx.dispenseItem.updateMany({ where: { id: itemId, tenantId: ctx.tenantId, returnedQuantity: { lte: item.quantity - quantity } }, data: { returnedQuantity: { increment: quantity } } });
      if (cap.count !== 1) throw new DomainError("INVALID_AMOUNT", `Only ${item.quantity - item.returnedQuantity} unit(s) of this item can still be returned`, 409);
      await this.stock.move(tx, ctx, { batchId: item.batchId, medicineId: item.medicineId, type: "PATIENT_RETURN", direction: "IN", quantity, sourceType: "DISPENSE_RETURN", sourceId: dispenseId, reason: input.reason });
      await tx.charge.updateMany({ where: { id: live.id, tenantId: ctx.tenantId, status: "PENDING" }, data: { status: "VOIDED", voidReason: `Pharmacy return: ${input.reason}`, voidedById: ctx.userId, voidedAt: new Date() } });
      const remaining = item.quantity - item.returnedQuantity - quantity;
      if (remaining > 0) {
        await tx.charge.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: d.patientId, admissionId: live.admissionId, type: "MEDICINE", description: live.description, quantity: remaining.toString(), unitPrice: live.unitPrice.toFixed(2), taxPercent: "0", sourceKey: `DISPENSE_ITEM:${itemId}:R${item.returnedQuantity + quantity}`, chargedById: ctx.userId } });
      }
    }
    const after = await tx.dispenseItem.findMany({ where: { tenantId: ctx.tenantId, dispenseId } });
    const status = after.every((i) => i.returnedQuantity === i.quantity) ? "RETURNED" : "PARTIALLY_RETURNED";
    await tx.dispense.updateMany({ where: { id: dispenseId, tenantId: ctx.tenantId }, data: { status } });
    await this.audit.record(tx, actorOf(ctx), { action: "PHARMACY_RETURN", entityType: "Dispense", entityId: dispenseId, metadata: { reason: input.reason, status, chargedToAdmission: true } });
    return { creditNoteNumber: null, creditedAmount: "0.00", dispense: await this.view(tx, ctx, dispenseId) };
  }

  async get(ctx: RequestContext, id: string) {
    const d = await this.prisma.dispense.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.view(this.prisma, ctx, id);
  }

  async list(ctx: RequestContext, q: z.infer<typeof dispenseListSchema>) {
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(q.patientId ? { patientId: q.patientId } : {}) };
    const [rows, total] = await Promise.all([
      this.prisma.dispense.findMany({ where, orderBy: { dispensedAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, select: { id: true } }),
      this.prisma.dispense.count({ where }),
    ]);
    return { items: await Promise.all(rows.map((r) => this.view(this.prisma, ctx, r.id))), total };
  }

  // ───── internals ─────

  private async explicitBatch(tx: Db, ctx: RequestContext, medicineId: string, batchId: string, quantity: number) {
    const today = await this.stock.today(tx, ctx);
    const b = await tx.medicineBatch.findFirst({ where: { id: batchId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, medicineId } });
    if (!b) throw new DomainError("VALIDATION_FAILED", "The selected batch does not belong to this medicine", 400, [{ path: "batchId", message: "Unknown batch" }]);
    if (b.status !== "ACTIVE") throw new DomainError("VALIDATION_FAILED", "The selected batch is blocked", 400);
    if (b.expiryDate < today) throw new DomainError("BATCH_EXPIRED", `Batch ${b.batchNo} has expired and cannot be dispensed`, 409);
    return [{ batchId: b.id, batchNo: b.batchNo, expiryDate: b.expiryDate, quantity, sellingPrice: b.sellingPrice.toString(), mrp: b.mrp.toString() }];
  }

  private async view(db: Db, ctx: RequestContext, id: string) {
    const d = await db.dispense.findFirstOrThrow({
      where: { id, tenantId: ctx.tenantId },
      include: { items: { orderBy: { lineNo: "asc" }, include: { medicine: { select: { brandName: true, genericName: true, strength: true } } } }, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } }, order: { select: { orderNumber: true } } },
    });
    const batches = await db.medicineBatch.findMany({ where: { tenantId: ctx.tenantId, id: { in: d.items.map((i) => i.batchId) } }, select: { id: true, batchNo: true, expiryDate: true } });
    const inv = d.invoiceId ? await db.invoice.findFirst({ where: { id: d.invoiceId, tenantId: ctx.tenantId }, select: { invoiceNumber: true, status: true, total: true, paidTotal: true, creditedTotal: true } }) : null;
    return {
      id: d.id, dispenseNumber: d.dispenseNumber, status: d.status, dispensedAt: d.dispensedAt, notes: d.notes, patientId: d.patientId, encounterId: d.encounterId,
      patientName: [d.patient.firstName, d.patient.lastName].filter(Boolean).join(" "), mrn: d.patient.identifiers[0]?.value ?? null, prescriptionNumber: d.order?.orderNumber ?? null,
      subtotal: fmt(d.subtotal), taxTotal: fmt(d.taxTotal), total: fmt(d.total), invoiceId: d.invoiceId,
      invoice: inv ? { invoiceNumber: inv.invoiceNumber, status: inv.status, total: fmt(inv.total), paidTotal: fmt(inv.paidTotal), creditedTotal: fmt(inv.creditedTotal) } : null,
      items: d.items.map((i) => ({
        id: i.id, lineNo: i.lineNo, medicineName: [i.medicine.brandName, i.medicine.strength].filter(Boolean).join(" "), genericName: i.medicine.genericName,
        batchNo: batches.find((b) => b.id === i.batchId)?.batchNo ?? null, expiryDate: batches.find((b) => b.id === i.batchId)?.expiryDate.toISOString().slice(0, 10) ?? null,
        quantity: i.quantity, returnedQuantity: i.returnedQuantity, unitPrice: fmt(i.unitPrice), taxPercent: fmt(i.taxPercent), lineTotal: fmt(i.lineTotal), medicationOrderItemId: i.medicationOrderItemId,
      })),
    };
  }
}
