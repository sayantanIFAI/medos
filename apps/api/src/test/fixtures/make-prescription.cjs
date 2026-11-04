/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node script, not part of the build */
// Renders a printed sample prescription (fictional patient) to prescription-sample.png for the OCR tests. Run: node make-prescription.cjs
const { createRequire } = require("module");
const path = require("path");
const { chromium } = createRequire(path.resolve(__dirname, "../../../../web/package.json"))("@playwright/test");
const html = `<html><body style="margin:0;background:#fff;font-family:Arial,'Nirmala UI',sans-serif;color:#000"><div style="width:1100px;padding:40px 50px;font-size:30px;line-height:1.55">
<div style="font-size:34px;font-weight:bold">Kolkata Care Clinic</div>
<div>Dr. Anita Sen, MD (Cardiology)</div><hr style="border:1px solid #000">
<div>Patient: Sunita Devi &nbsp;&nbsp; Age: 38 &nbsp;&nbsp; Date: 04/11/2026</div>
<div style="margin-top:14px;font-weight:bold">Rx</div>
<div>1. Tab Amlodipine 5 mg once daily for 30 days</div>
<div>2. Tab Atorvastatin 10 mg at night</div>
<div style="margin-top:14px">Investigations: CBC, Lipid Profile, HbA1c, TSH</div>
<div>थायराइड जांच भी करवाएं</div>
<div style="margin-top:14px">Follow up with Dr. Anita Sen after 2 weeks.</div>
</div></body></html>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 700 } });
  await p.setContent(html); await p.screenshot({ path: __dirname + "/prescription-sample.png", clip: { x: 0, y: 0, width: 1200, height: 640 } }); await b.close(); console.log("written");
})();
