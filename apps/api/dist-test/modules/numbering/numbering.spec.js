"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const harness_1 = require("../../test/harness");
const numbering_service_1 = require("./numbering.service");
(0, node_test_1.describe)("number sequence engine", () => {
    let t;
    let a;
    let b;
    let numbering;
    const next = (tenant, type, facilityId = tenant.facilityId, at) => t.prisma.$transaction((tx) => numbering.next(tx, tenant.tenantId, facilityId, type, at));
    (0, node_test_1.before)(async () => {
        t = await (0, harness_1.startApp)();
        numbering = t.app.get(numbering_service_1.NumberingService);
        a = await t.makeTenant("seq-a");
        b = await t.makeTenant("seq-b");
    });
    (0, node_test_1.after)(async () => { await t.close(); });
    (0, node_test_1.it)("formats numbers from the configured pattern, padding and facility code", async () => {
        const f = await t.prisma.facility.findFirstOrThrow({ where: { id: a.facilityId } });
        strict_1.default.equal(await next(a, "MRN"), `${f.code}-000001`);
        strict_1.default.equal(await next(a, "MRN"), `${f.code}-000002`);
        const year = new Date().getFullYear();
        strict_1.default.equal(await next(a, "INVOICE"), `INV-${year}-000001`);
    });
    (0, node_test_1.it)("generates unique, gap-free numbers under heavy parallel load", async () => {
        const N = 60;
        const results = await Promise.all(Array.from({ length: N }, () => next(a, "RECEIPT")));
        strict_1.default.equal(new Set(results).size, N, "no duplicates");
        const seqs = results.map((r) => Number(r.split("-").pop())).sort((x, y) => x - y);
        strict_1.default.deepEqual(seqs, Array.from({ length: N }, (_, i) => i + 1));
    });
    (0, node_test_1.it)("rolls the number back with its transaction (no gaps from failed work)", async () => {
        await strict_1.default.rejects(() => t.prisma.$transaction(async (tx) => {
            await numbering.next(tx, a.tenantId, a.facilityId, "PRESCRIPTION");
            throw new Error("simulated business failure");
        }));
        const n = await next(a, "PRESCRIPTION");
        strict_1.default.ok(n.endsWith("-000001"), n);
    });
    (0, node_test_1.it)("keeps counters independent per tenant, per facility and per type", async () => {
        const x = await next(b, "ADMISSION");
        const y = await next(a, "ADMISSION");
        const z = await next(a, "ADMISSION", a.facility2Id);
        for (const v of [x, y, z])
            strict_1.default.ok(v.endsWith("-000001"), v);
        strict_1.default.ok((await next(a, "OPD_VISIT")).endsWith("-000001"));
    });
    (0, node_test_1.it)("resets yearly sequences at the facility's local new year (Asia/Kolkata)", async () => {
        const lateDec = new Date("2026-12-31T17:00:00Z"); // 22:30 IST, still 2026
        const newYearIst = new Date("2026-12-31T19:00:00Z"); // 00:30 IST on 1 Jan 2027
        const a1 = await next(a, "CREDIT_NOTE", a.facilityId, lateDec);
        const a2 = await next(a, "CREDIT_NOTE", a.facilityId, newYearIst);
        const a3 = await next(a, "CREDIT_NOTE", a.facilityId, newYearIst);
        strict_1.default.equal(a1, "CN-2026-000001");
        strict_1.default.equal(a2, "CN-2027-000001");
        strict_1.default.equal(a3, "CN-2027-000002");
    });
    (0, node_test_1.it)("rejects an unknown facility without leaking whether it exists in another tenant", async () => {
        await strict_1.default.rejects(() => next(a, "MRN", b.facilityId), (e) => e.code === "FACILITY_NOT_FOUND");
    });
    (0, node_test_1.it)("admin can view and change the pattern; changes apply to future numbers and are audited", async () => {
        const list = await t.api("get", "/number-sequences", a.admin.token);
        strict_1.default.equal(list.status, 200);
        strict_1.default.ok(list.body.data.find((s) => s.type === "MRN"));
        const put = await t.api("put", "/number-sequences/EMPTYTYPE", a.admin.token).send({ pattern: "X-{SEQ}", padding: 4, resetPolicy: "NEVER" });
        strict_1.default.equal(put.status, 404);
        const ok = await t.api("put", "/number-sequences/PURCHASE", a.admin.token).send({ pattern: "PO/{FACILITY}/{YEAR}/{SEQ}", padding: 4, resetPolicy: "YEARLY" });
        strict_1.default.equal(ok.status, 200);
        const f = await t.prisma.facility.findFirstOrThrow({ where: { id: a.facilityId } });
        strict_1.default.match(await next(a, "PURCHASE"), new RegExp(`^PO/${f.code}/\\d{4}/0001$`));
        strict_1.default.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "NUMBER_SEQUENCE_CONFIG_CHANGED" } }));
    });
    (0, node_test_1.it)("rejects unsafe or collision-prone configurations", async () => {
        const bad = [
            { pattern: "NOSEQ-{YEAR}", padding: 6, resetPolicy: "YEARLY" },
            { pattern: "INV-{SEQ}", padding: 6, resetPolicy: "YEARLY" },
            { pattern: "INV-{BOGUS}-{SEQ}", padding: 6, resetPolicy: "NEVER" },
            { pattern: "INV-{SEQ}-<script>", padding: 6, resetPolicy: "NEVER" },
            { pattern: "INV-{SEQ}", padding: 0, resetPolicy: "NEVER" },
            { pattern: "INV-{SEQ}", padding: 13, resetPolicy: "NEVER" },
        ];
        for (const body of bad)
            strict_1.default.equal((await t.api("put", "/number-sequences/INVOICE", a.admin.token).send(body)).status, 400, JSON.stringify(body));
    });
    (0, node_test_1.it)("only administrators with settings permission can configure sequences", async () => {
        const cashier = await t.makeUser(a, ["CASHIER"]);
        strict_1.default.equal((await t.api("put", "/number-sequences/INVOICE", cashier.token).send({ pattern: "I-{SEQ}", padding: 6, resetPolicy: "NEVER" })).status, 403);
    });
    (0, node_test_1.it)("the database refuses negative counters", async () => {
        await strict_1.default.rejects(() => t.prisma.$executeRaw `UPDATE "NumberSequence" SET "lastValue" = -1 WHERE "tenantId" = ${a.tenantId}::uuid`);
    });
});
//# sourceMappingURL=numbering.spec.js.map