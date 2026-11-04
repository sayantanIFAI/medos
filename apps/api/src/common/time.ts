// The time helpers live in the shared front-desk package (the voicebot and OCR apps need them too); this keeps the old import path working.
export { localParts, localDateStr, dateOnly, zonedToUtc, localMinutes, startOfLocalDay, endOfLocalDay, formatHm, parseHm } from "@medos/frontdesk-core";
export type { LocalParts } from "@medos/frontdesk-core";
