import { Inject, Injectable } from "@nestjs/common";
import { PodClient, type OcrEngine, type OcrResult } from "@medos/frontdesk-core";
import { CONFIG, type AppConfig } from "../../common/config";

export type { OcrEngine, OcrResult };

/**
 * Reads a prescription on the AI pod, not on this machine (the work is PodClient's, shared with the OCR app). Printed prescriptions read
 * well; handwriting reads poorly, which is why every automatic booking is gated on the reading confidence and anything uncertain goes to
 * staff. If the pod cannot be reached the scan fails with a plain message, and the prescription is booked by hand as before.
 */
@Injectable()
export class OcrService implements OcrEngine {
  private readonly pod: PodClient;
  constructor(@Inject(CONFIG) cfg: AppConfig) { this.pod = new PodClient({ url: cfg.AI_REMOTE_URL, token: cfg.AI_REMOTE_TOKEN, timeoutMs: cfg.AI_REMOTE_TIMEOUT_MS }); }
  readImage(data: Buffer, contentType = "image/png"): Promise<OcrResult> { return this.pod.readImage(data, contentType); }
  readPdf(data: Buffer): Promise<OcrResult> { return this.pod.readPdf(data); }
}
