import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { PrintService, type Rendered } from "./print.service";

const formatQuery = z.object({ format: z.enum(["html", "pdf"]).default("html"), download: z.enum(["0", "1"]).default("0") }).strict();

/**
 * Printable documents: server-rendered, fully escaped HTML (default) or a PDF (`?format=pdf`, add `&download=1` to force a download).
 * Both are served with a locked-down CSP (no scripts, no network) and are never cached.
 */
function send(res: Response, r: Rendered, download: boolean) {
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (r.contentType === "application/pdf") res.setHeader("Content-Disposition", `${download ? "attachment" : "inline"}; filename="${r.fileName}"`);
  res.type(r.contentType).send(r.body);
}

@Controller("print")
export class PrintController {
  constructor(private readonly print: PrintService) {}

  @RequirePermissions("INVOICE_READ")
  @Get("invoices/:id")
  async invoice(@Ctx() ctx: RequestContext, @Param("id") invoiceId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    send(res, await this.print.invoice(ctx, id(invoiceId), q.format), q.download === "1");
  }

  @RequirePermissions("INVOICE_READ")
  @Get("receipts/:id")
  async receipt(@Ctx() ctx: RequestContext, @Param("id") receiptId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    send(res, await this.print.receipt(ctx, id(receiptId), q.format), q.download === "1");
  }

  @RequirePermissions("PRESCRIPTION_READ")
  @Get("prescriptions/:encounterId")
  async prescription(@Ctx() ctx: RequestContext, @Param("encounterId") encounterId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    send(res, await this.print.prescription(ctx, id(encounterId), q.format), q.download === "1");
  }

  @RequirePermissions("CONSULTATION_READ")
  @Get("discharge-summaries/:admissionId")
  async dischargeSummary(@Ctx() ctx: RequestContext, @Param("admissionId") admissionId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    send(res, await this.print.dischargeSummary(ctx, id(admissionId), q.format), q.download === "1");
  }

  @RequirePermissions("PATIENT_READ")
  @Get("patient-labels/:patientId")
  async patientLabel(@Ctx() ctx: RequestContext, @Param("patientId") patientId: string, @Query() query: unknown, @Res() res: Response) {
    const q = parse(formatQuery, query);
    send(res, await this.print.patientLabel(ctx, id(patientId), q.format), q.download === "1");
  }
}
