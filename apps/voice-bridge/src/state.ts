import * as fs from "node:fs";
import * as path from "node:path";

/**
 * What the bridge must remember between runs. No patient details are kept here: only booking numbers, the cursor and
 * what went wrong, so the file is safe to look at and safe to delete (the bridge then re-reads and MedOS ignores replays).
 */
export interface BridgeState {
  /** How many bytes of the voice bot's booking log have been read (it only ever grows). */
  logOffset: number;
  /** Confirmed, upcoming bookings still watched for a cancellation or a reschedule. */
  tracked: Record<string, { startsAt: number }>;
  /** Bookings MedOS refused for a reason a person must fix (doctor not found, age missing, slot clash). */
  failed: Record<string, { code: string; message: string; at: string }>;
}

export const emptyState = (): BridgeState => ({ logOffset: 0, tracked: {}, failed: {} });

export class StateStore {
  state: BridgeState;
  constructor(private readonly file: string | null) {
    this.state = emptyState();
    if (file && fs.existsSync(file)) {
      try {
        this.state = { ...emptyState(), ...(JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BridgeState>) };
      } catch {
        this.state = emptyState(); // a damaged file is not worth stopping for: replays are harmless
      }
    }
  }

  save(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
