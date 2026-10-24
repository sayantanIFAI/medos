import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { InvoicesService } from "../billing/invoices.service";
import { PaymentsService } from "../billing/payments.service";
import { SummaryService, type SummaryContent } from "../discharge/summary.service";
import { SettingsService } from "../settings/settings.service";
import { toHtml, type Block, type Doc } from "./doc";
import type { PrintHeader } from "./html";
import { toPdf } from "./pdf";

type DocType = "INVOICE" | "RECEIPT" | "PRESCRIPTION" | "DISCHARGE_SUMMARY" | "PATIENT_LABEL";
export type PrintFormat = "html" | "pdf";
export interface Rendered { contentType: string; body: string | Buffer; fileName: string }

const notFound = () => new DomainError("NOT_FOUND", "Resource not found", 404);
const fullName = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");
const FREQ: Record<string, string> = { OD: "Once daily", BD: "Twice daily", TDS: "Three times daily", QID: "Four times daily", HS: "At bedtime", SOS: "If needed", STAT: "Immediately", OTHER: "As directed" };
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";

@Injectable()
export class PrintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly invoices: InvoicesService,
    private readonly payments: PaymentsService,
    private readonly summaries: SummaryService,
  ) {}

  private async env(ctx: RequestContext) {
    const [facility, header, footer, user] = await Promise.all([
      this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId } }),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRINT_HEADER"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRINT_FOOTER"),
      this.prisma.user.findFirst({ where: { id: ctx.userId, tenantId: ctx.tenantId }, select: { fullName: true } }),
    ]);
    const fallback: PrintHeader = {
      hospitalName: facility.name, address: [facility.address, facility.city, facility.state, facility.postalCode].filter(Boolean).join(", ") || undefined,
      phone: facility.phone ?? undefined, email: facility.email ?? undefined, gstin: facility.gstin ?? undefined,
    };
    const tz = facility.timezone;
    const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: tz, dateStyle: "medium", timeStyle: "short" });
    const fmtDay = new Intl.DateTimeFormat("en-IN", { timeZone: tz, dateStyle: "medium" });
    return {
      header: (header as PrintHeader | null) ?? fallback, footer: footer as Record<string, string | undefined>, printedBy: user?.fullName ?? "-",
      at: (d: Date | null | undefined) => (d ? fmt.format(d) : ""), day: (d: Date | null | undefined) => (d ? fmtDay.format(d) : ""), now: fmt.format(new Date()),
    };
  }

  /** Every print is audited (once per request, whatever the format); a second print of the same record is stamped as a duplicate. */
  private async finish(ctx: RequestContext, type: DocType, entityType: string, entityId: string, format: PrintFormat, build: (banner: string | undefined) => Doc): Promise<Rendered> {
    const doc = await this.prisma.$transaction(async (tx) => {
      const prior = await tx.auditEvent.count({ where: { tenantId: ctx.tenantId, action: "DOCUMENT_PRINTED", entityType, entityId } });
      await this.audit.record(tx, actorOf(ctx), { action: "DOCUMENT_PRINTED", entityType, entityId, metadata: { documentType: type, format, copy: prior + 1 } });
      return build(prior > 0 ? "DUPLICATE COPY" : undefined);
    });
    return format === "pdf"
      ? { contentType: "application/pdf", body: await toPdf(doc), fileName: `${doc.fileBase}.pdf` }
      : { contentType: "text/html; charset=utf-8", body: toHtml(doc), fileName: `${doc.fileBase}.html` };
  }

  async invoice(ctx: RequestContext, invoiceId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const inv = await this.invoices.get(ctx, invoiceId);
    if (inv.status === "DRAFT") throw new DomainError("INVALID_STATE", "Issue the invoice before printing it", 409);
    const e = await this.env(ctx);
    return this.finish(ctx, "INVOICE", "Invoice", inv.id, format, (dup) => ({
      title: `Invoice ${inv.invoiceNumber}`, fileBase: `invoice-${slug(str(inv.invoiceNumber))}`, header: e.header, footer: e.footer.invoice, printedBy: e.printedBy, printedAt: e.now,
      banner: inv.status === "CANCELLED" ? "CANCELLED" : dup,
      blocks: [
        { t: "title", text: `Invoice ${str(inv.invoiceNumber)}` },
        { t: "kv", rows: [["Patient", inv.patientName], ["MRN", inv.mrn], ["Date", e.at(inv.issuedAt)], ["Status", inv.status]] },
        { t: "table", head: [{ label: "#" }, { label: "Description" }, { label: "Qty", numeric: true }, { label: "Rate", numeric: true }, { label: "Disc.", numeric: true }, { label: "Tax %", numeric: true }, { label: "Amount", numeric: true }],
          rows: inv.lines.map((l) => [str(l.lineNo), l.description, l.quantity, l.unitPrice, l.discountAmount, l.taxPercent, l.lineTotal]) },
        { t: "table", head: [{ label: "Summary" }, { label: "INR", numeric: true }], rows: [["Subtotal", inv.subtotal], ["Discount", inv.discountTotal], ["Tax", inv.taxTotal], ["Total", inv.total], ["Paid", inv.paidTotal], ["Refunded", inv.refundedTotal], ["Credit notes", inv.creditedTotal], ["Balance due", inv.balanceDue]] },
        ...(inv.notes ? [{ t: "para", text: inv.notes } as Block] : []),
      ],
    }));
  }

  async receipt(ctx: RequestContext, receiptId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const r = await this.payments.getReceipt(ctx, receiptId);
    const e = await this.env(ctx);
    return this.finish(ctx, "RECEIPT", "Receipt", r.id, format, (banner) => ({
      title: `Receipt ${r.receiptNumber}`, fileBase: `receipt-${slug(r.receiptNumber)}`, header: e.header, footer: e.footer.receipt, printedBy: e.printedBy, printedAt: e.now, banner,
      blocks: [
        { t: "title", text: `Receipt ${r.receiptNumber}` },
        { t: "kv", rows: [["Patient", r.patientName], ["MRN", r.mrn], ["Invoice", r.invoiceNumber], ["Date", e.at(r.receivedAt)], ["Received by", r.receivedBy]] },
        { t: "table", head: [{ label: "Mode" }, { label: "Reference" }, { label: "INR", numeric: true }], rows: [...r.payments.map((p) => [p.method, p.reference ?? "", p.amount]), ["Total", "", r.total]] },
      ],
    }));
  }

  /** Prints the doctor's signed prescription for an OPD or IPD encounter. Drafts are never printable. */
  async prescription(ctx: RequestContext, encounterId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const enc = await this.prisma.encounter.findFirst({
      where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: { patient: { include: { identifiers: { where: { type: "MRN" } } } }, practitioner: { select: { displayName: true } } },
    });
    if (!enc) throw notFound();
    const order = await this.prisma.medicationOrder.findFirst({ where: { tenantId: ctx.tenantId, encounterId, status: "SIGNED" }, include: { items: { orderBy: { lineNo: "asc" } } }, orderBy: { signedAt: "desc" } });
    if (!order) throw new DomainError("INVALID_STATE", "There is no signed prescription to print", 409);
    const signer = order.signedById ? await this.prisma.user.findFirst({ where: { id: order.signedById, tenantId: ctx.tenantId }, select: { fullName: true } }) : null;
    const allergies = await this.prisma.allergy.findMany({ where: { tenantId: ctx.tenantId, patientId: enc.patientId, status: "ACTIVE" }, select: { allergen: true } });
    const e = await this.env(ctx);
    const p = enc.patient;
    return this.finish(ctx, "PRESCRIPTION", "MedicationOrder", order.id, format, (banner) => ({
      title: `Prescription ${order.orderNumber}`, fileBase: `prescription-${slug(str(order.orderNumber))}`, header: e.header, footer: e.footer.prescription, printedBy: e.printedBy, printedAt: e.now, banner,
      blocks: [
        { t: "title", text: `Prescription ${str(order.orderNumber)}` },
        { t: "kv", rows: [["Patient", fullName(p)], ["MRN", p.identifiers[0]?.value], ["Gender", p.gender], ["Age/DOB", p.dateOfBirth ? e.day(p.dateOfBirth) : p.estimatedAgeYears ? `~${p.estimatedAgeYears} y` : ""], ["Encounter", enc.encounterNumber], ["Date", e.at(order.signedAt)], ["Doctor", enc.practitioner?.displayName ?? signer?.fullName]] },
        ...(allergies.length ? [{ t: "note", text: `Known allergies: ${allergies.map((a) => a.allergen).join(", ")}` } as Block] : []),
        { t: "table", head: [{ label: "#" }, { label: "Medicine" }, { label: "Dose" }, { label: "Route" }, { label: "Frequency" }, { label: "Days", numeric: true }, { label: "Instructions" }],
          rows: order.items.map((i) => [str(i.lineNo), [i.brandName ?? i.genericName, i.brandName ? `(${i.genericName})` : "", i.strength ?? ""].filter(Boolean).join(" ") + (i.status === "STOPPED" ? " [STOPPED]" : ""), i.dosage, i.route, FREQ[i.frequency] ?? i.frequency, str(i.durationDays), i.instructions ?? ""]) },
        { t: "signature", lines: [signer?.fullName ?? "", `Signed ${e.at(order.signedAt)}`] },
      ],
    }));
  }

  /** Only a signed (or amended) summary is printable; the printed text is the signed version. */
  async dischargeSummary(ctx: RequestContext, admissionId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const s = await this.summaries.get(ctx, admissionId);
    if (!s.document || s.document.status === "DRAFT") throw new DomainError("INVALID_STATE", "The discharge summary must be signed before printing", 409);
    const doc = s.document;
    const c = doc.content as SummaryContent;
    const a = s.admission;
    const e = await this.env(ctx);
    const section = (t: string, v: string | undefined): Block[] => (v ? [{ t: "heading", text: t }, { t: "para", text: v }] : []);
    return this.finish(ctx, "DISCHARGE_SUMMARY", "ClinicalDocument", doc.id, format, (banner) => ({
      title: "Discharge Summary", fileBase: `discharge-summary-${slug(a.admissionNumber)}`, header: e.header, footer: e.footer.dischargeSummary, printedBy: e.printedBy, printedAt: e.now, banner,
      blocks: [
        { t: "title", text: "Discharge Summary" },
        { t: "kv", rows: [["Patient", a.patientName], ["MRN", a.mrn], ["Admission no.", a.admissionNumber], ["Admitted", e.at(a.admittedAt)], ["Discharged", e.at(a.dischargedAt)], ["Outcome", a.dischargeType], ["Consultant", a.consultant], ["Department", a.department]] },
        ...(c.finalDiagnoses.length ? [{ t: "heading", text: "Final diagnoses" } as Block, { t: "table", head: [{ label: "Diagnosis" }, { label: "Code" }], rows: c.finalDiagnoses.map((d) => [d.text, d.code ?? ""]) } as Block] : []),
        ...section("Hospital course", c.hospitalCourse),
        ...(c.procedures.length ? [{ t: "heading", text: "Procedures" } as Block, { t: "table", head: [{ label: "Procedure" }, { label: "Date" }, { label: "Notes" }], rows: c.procedures.map((p) => [p.name, p.date ?? "", p.notes ?? ""]) } as Block] : []),
        ...section("Investigations", c.investigationSummary), ...section("Condition at discharge", c.conditionAtDischarge),
        ...(c.dischargeMedications.length ? [{ t: "heading", text: "Discharge medications" } as Block, { t: "table", head: [{ label: "Medicine" }, { label: "Dose" }, { label: "Route" }, { label: "Frequency" }, { label: "Days", numeric: true }, { label: "Instructions" }],
          rows: c.dischargeMedications.map((m) => [[m.brandName ?? m.genericName, m.strength ?? ""].filter(Boolean).join(" "), m.dosage, m.route, FREQ[m.frequency] ?? m.frequency, str(m.durationDays), m.instructions ?? ""]) } as Block] : []),
        ...section("Advice", c.advice),
        ...(c.followUp ? [{ t: "heading", text: "Follow-up" } as Block, { t: "para", text: [c.followUp.date && `On ${c.followUp.date}`, c.followUp.afterDays && `After ${c.followUp.afterDays} days`, c.followUp.notes].filter(Boolean).join(" - ") } as Block] : []),
        { t: "signature", lines: [doc.signedByName ?? "", `Signed ${e.at(doc.signedAt)} - version ${doc.currentVersion}`] },
      ],
    }));
  }

  async patientLabel(ctx: RequestContext, patientId: string, format: PrintFormat = "html"): Promise<Rendered> {
    const p = await this.prisma.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, include: { identifiers: { where: { type: "MRN" } } } });
    if (!p) throw notFound();
    const e = await this.env(ctx);
    return this.finish(ctx, "PATIENT_LABEL", "Patient", p.id, format, () => ({
      title: "Patient label", fileBase: `label-${slug(p.identifiers[0]?.value ?? p.id.slice(0, 8))}`, header: e.header, printedBy: e.printedBy, printedAt: e.now,
      blocks: [
        { t: "title", text: fullName(p) },
        { t: "kv", rows: [["MRN", p.identifiers[0]?.value], ["Gender", p.gender], ["DOB", e.day(p.dateOfBirth)], ["Mobile", p.mobile], ["Blood group", p.bloodGroup]] },
      ],
    }));
  }
}
