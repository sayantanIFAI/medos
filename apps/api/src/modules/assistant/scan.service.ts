import { Inject, Injectable } from "@nestjs/common";
import { MAX_SCAN_BYTES, MIN_AUTO_CONFIDENCE, scanPrescription, type OcrEngine, type ScanResult } from "@medos/frontdesk-core";
import { z } from "zod";
import type { RequestContext } from "../../common/request-context";
import { FrontDeskPorts } from "../frontdesk/prisma-port";
import { OcrService } from "./ocr.service";

export { MAX_SCAN_BYTES, MIN_AUTO_CONFIDENCE };
export type { ScanResult };

export const scanQuerySchema = z.object({
  patientId: z.string().uuid().optional(),
  autoBook: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  filename: z.string().trim().max(120).default("prescription"),
}).strict();

/**
 * The built-in prescription screen. Reading, planning and booking are the same code the separate OCR app runs (@medos/frontdesk-core,
 * scan-flow.ts); here it works with the signed-in user's own rights, straight against MedOS's services.
 */
@Injectable()
export class PrescriptionScanService {
  constructor(private readonly ports: FrontDeskPorts, @Inject(OcrService) private ocr: OcrEngine) {}

  /** For tests: swap in a fake reading engine. */
  useEngine(engine: OcrEngine): void { this.ocr = engine; }

  scan(ctx: RequestContext, q: z.infer<typeof scanQuerySchema>, data: unknown): Promise<ScanResult> {
    return scanPrescription(this.ports.forContext(ctx), this.ocr, data, { patientId: q.patientId, autoBook: q.autoBook, filename: q.filename });
  }
}
