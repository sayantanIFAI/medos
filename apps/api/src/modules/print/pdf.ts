import PDFDocument from "pdfkit";
import type { Doc } from "./doc";

/**
 * PDF renderer (pdfkit, MIT). Uses the built-in Helvetica fonts, which cover Latin text; other scripts need an embedded Unicode
 * font (tracked in REMINDER.md). Characters outside the font's range are replaced rather than dropped silently.
 */
const REPLACEMENTS: Record<string, string> = { "₹": "Rs.", "–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "•": "-", "…": "...", "·": "-", " ": " " };
export const safe = (s: unknown): string => String(s ?? "").replace(/[^\x09\x0a\x20-\x7e\xa0-\xff]/g, (c) => REPLACEMENTS[c] ?? "?").replace(/[ ·]/g, (c) => REPLACEMENTS[c] ?? c);

const M = 40;
const W = 595.28 - 2 * M;
const BOTTOM = 841.89 - M - 24;
const GRAY = "#555555";

function logoBuffer(dataUrl: string | undefined): Buffer | null {
  const m = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
  return m ? Buffer.from(m[1]!, "base64") : null;
}

export function toPdf(d: Doc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: { Title: safe(d.title), Producer: "MedOS", Creator: "MedOS" } });
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const ensure = (h: number) => { if (pdf.y + h > BOTTOM) pdf.addPage(); };

    // header
    const top = pdf.y;
    let textX = M;
    const logo = logoBuffer(d.header.logoDataUrl);
    if (logo) { try { pdf.image(logo, M, top, { fit: [90, 48] }); textX = M + 100; } catch { /* unreadable logo: print without it */ } }
    pdf.font("Helvetica-Bold").fontSize(16).fillColor("#000").text(safe(d.header.hospitalName), textX, top, { width: W - (textX - M) });
    pdf.font("Helvetica").fontSize(9).fillColor(GRAY);
    if (d.header.tagline) pdf.text(safe(d.header.tagline), textX, pdf.y, { width: W - (textX - M) });
    const contact = [d.header.address, d.header.phone && `Ph: ${d.header.phone}`, d.header.email, d.header.gstin && `GSTIN: ${d.header.gstin}`].filter(Boolean).join("  |  ");
    if (contact) pdf.text(safe(contact), textX, pdf.y, { width: W - (textX - M) });
    pdf.y = Math.max(pdf.y, top + (logo ? 52 : 0)) + 6;
    pdf.moveTo(M, pdf.y).lineTo(M + W, pdf.y).lineWidth(1.5).strokeColor("#000").stroke();
    pdf.y += 10;

    if (d.banner) {
      ensure(30);
      pdf.font("Helvetica-Bold").fontSize(11).fillColor("#b00000");
      const bh = pdf.heightOfString(safe(d.banner), { width: W - 12 }) + 8;
      pdf.rect(M, pdf.y, W, bh).lineWidth(1.2).strokeColor("#b00000").stroke();
      pdf.text(safe(d.banner), M + 6, pdf.y + 4, { width: W - 12, align: "center" });
      pdf.y += bh + 8;
    }

    for (const b of d.blocks) {
      pdf.x = M;
      switch (b.t) {
        case "title":
          ensure(28); pdf.font("Helvetica-Bold").fontSize(14).fillColor("#000").text(safe(b.text), M, pdf.y, { width: W }); pdf.y += 6; break;
        case "heading":
          ensure(26); pdf.y += 6; pdf.font("Helvetica-Bold").fontSize(9.5).fillColor("#000").text(safe(b.text).toUpperCase(), M, pdf.y, { width: W }); pdf.y += 3; break;
        case "para":
          pdf.font("Helvetica").fontSize(10).fillColor("#000"); ensure(pdf.heightOfString(safe(b.text), { width: W }) > BOTTOM - pdf.y ? 40 : pdf.heightOfString(safe(b.text), { width: W }));
          pdf.text(safe(b.text), M, pdf.y, { width: W }); pdf.y += 4; break;
        case "note":
          ensure(20); pdf.font("Helvetica-Bold").fontSize(10).fillColor("#000").text(safe(b.text), M, pdf.y, { width: W }); pdf.y += 4; break;
        case "signature":
          ensure(24 + b.lines.length * 12); pdf.y += 20; pdf.font("Helvetica").fontSize(10).fillColor("#000");
          for (const l of b.lines) pdf.text(safe(l), M, pdf.y, { width: W, align: "right" });
          break;
        case "kv": {
          const rows = b.rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
          const colW = W / 2 - 6;
          for (let i = 0; i < rows.length; i += 2) {
            const pair = rows.slice(i, i + 2);
            pdf.font("Helvetica").fontSize(9.5);
            const h = Math.max(...pair.map(([k, v]) => pdf.heightOfString(`${safe(k)}: ${safe(v)}`, { width: colW }))) + 3;
            ensure(h);
            const y = pdf.y;
            pair.forEach(([k, v], j) => {
              const x = M + j * (colW + 12);
              pdf.font("Helvetica-Bold").fillColor("#000").text(`${safe(k)}: `, x, y, { width: colW, continued: true }).font("Helvetica").text(safe(v), { width: colW });
            });
            pdf.y = y + h;
          }
          pdf.y += 3; break;
        }
        case "table": {
          const n = b.head.length;
          const weights = b.head.map((h, c) => {
            const longest = Math.max(h.label.length, ...b.rows.map((r) => Math.min(40, safe(r[c]).length)));
            return h.numeric ? Math.max(6, Math.min(longest, 12)) : Math.max(8, longest);
          });
          const total = weights.reduce((a, x) => a + x, 0);
          const widths = weights.map((x) => (x / total) * W);
          const pad = 3;
          const drawHead = () => {
            pdf.font("Helvetica-Bold").fontSize(8.5).fillColor("#000");
            const h = Math.max(...b.head.map((c, i) => pdf.heightOfString(safe(c.label), { width: widths[i]! - 2 * pad }))) + 2 * pad;
            ensure(h + 14);
            const y = pdf.y;
            let x = M;
            b.head.forEach((c, i) => { pdf.text(safe(c.label), x + pad, y + pad, { width: widths[i]! - 2 * pad, align: c.numeric ? "right" : "left" }); x += widths[i]!; });
            pdf.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.8).strokeColor("#000").stroke();
            pdf.y = y + h;
          };
          drawHead();
          for (const r of b.rows) {
            pdf.font("Helvetica").fontSize(9);
            const h = Math.max(...r.map((c, i) => pdf.heightOfString(safe(c), { width: widths[i]! - 2 * pad }))) + 2 * pad;
            if (pdf.y + h > BOTTOM) { pdf.addPage(); drawHead(); pdf.font("Helvetica").fontSize(9); }
            const y = pdf.y;
            let x = M;
            for (let i = 0; i < n; i++) { pdf.fillColor("#000").text(safe(r[i]), x + pad, y + pad, { width: widths[i]! - 2 * pad, align: b.head[i]?.numeric ? "right" : "left" }); x += widths[i]!; }
            pdf.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.3).strokeColor("#bbbbbb").stroke();
            pdf.y = y + h;
          }
          pdf.y += 6; break;
        }
      }
    }

    // footer text after the content
    ensure(40);
    pdf.y += 10;
    pdf.moveTo(M, pdf.y).lineTo(M + W, pdf.y).lineWidth(0.5).strokeColor("#999999").stroke();
    pdf.y += 5;
    pdf.font("Helvetica").fontSize(8.5).fillColor(GRAY);
    if (d.footer) pdf.text(safe(d.footer), M, pdf.y, { width: W });
    pdf.text(`Printed by ${safe(d.printedBy)} on ${safe(d.printedAt)}`, M, pdf.y, { width: W });

    // page numbers
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      pdf.font("Helvetica").fontSize(8).fillColor(GRAY).text(`Page ${i - range.start + 1} of ${range.count}`, M, 841.89 - M + 6, { width: W, align: "right", lineBreak: false });
    }
    pdf.end();
  });
}
