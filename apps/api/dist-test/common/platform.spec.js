"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const harness_1 = require("../test/harness");
(0, node_test_1.describe)("platform behaviour: errors, headers, audit integrity", () => {
    let t;
    let tenant;
    (0, node_test_1.before)(async () => {
        t = await (0, harness_1.startApp)();
        tenant = await t.makeTenant("plat");
    });
    (0, node_test_1.after)(async () => { await t.close(); });
    (0, node_test_1.it)("exposes public liveness and readiness endpoints", async () => {
        strict_1.default.equal((await t.api("get", "/health")).status, 200);
        const ready = await t.api("get", "/health/ready");
        strict_1.default.equal(ready.status, 200);
        strict_1.default.equal(ready.body.data.status, "ready");
    });
    (0, node_test_1.it)("returns the stable error envelope without stack traces for unknown routes and malformed bodies", async () => {
        const nf = await t.api("get", "/nope", tenant.admin.token);
        strict_1.default.equal(nf.status, 404);
        strict_1.default.equal(nf.body.error.code, "NOT_FOUND");
        const bad = await t.http().post("/api/v1/auth/login").set("Content-Type", "application/json").send("{not json");
        strict_1.default.equal(bad.status, 400);
        strict_1.default.equal(bad.body.error.code, "VALIDATION_FAILED");
        for (const r of [nf, bad]) {
            const text = JSON.stringify(r.body);
            strict_1.default.ok(!/at \w+.*\(.*:\d+:\d+\)/.test(text), `no stack frames: ${text}`);
            strict_1.default.ok(!text.includes("node_modules") && !text.includes("prisma"), `no internals: ${text}`);
            strict_1.default.ok(r.body.error.requestId, `requestId present: ${JSON.stringify(r.body)}`);
        }
    });
    (0, node_test_1.it)("rejects oversized request bodies", async () => {
        const r = await t.http().post("/api/v1/auth/login").send({ tenantCode: "x".repeat(400_000), identifier: "a", password: "b" });
        strict_1.default.equal(r.status, 413);
        strict_1.default.equal(r.body.error.code, "PAYLOAD_TOO_LARGE");
    });
    (0, node_test_1.it)("sets security headers, hides the framework, and echoes a safe request id", async () => {
        const r = await t.api("get", "/health").set("x-request-id", "req-12345678");
        strict_1.default.equal(r.headers["x-request-id"], "req-12345678");
        strict_1.default.equal(r.headers["x-content-type-options"], "nosniff");
        strict_1.default.equal(r.headers["x-powered-by"], undefined);
        const evil = await t.api("get", "/health").set("x-request-id", "bad id\"<script>");
        strict_1.default.match(String(evil.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
    });
    (0, node_test_1.it)("does not leak database errors: unique violations become CONFLICT, never SQL", async () => {
        const r = await t.api("post", "/roles", tenant.admin.token).send({ name: "ADMINISTRATOR", permissions: ["PATIENT_READ"] });
        strict_1.default.equal(r.status, 409);
        strict_1.default.ok(!JSON.stringify(r.body).toLowerCase().includes("unique constraint"));
    });
    (0, node_test_1.it)("audit events are append-only at the database level (UPDATE, DELETE and TRUNCATE all fail)", async () => {
        const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.tenantId } });
        await strict_1.default.rejects(() => t.prisma.auditEvent.update({ where: { id: evt.id }, data: { action: "TAMPERED" } }), /append-only/);
        await strict_1.default.rejects(() => t.prisma.auditEvent.delete({ where: { id: evt.id } }), /append-only/);
        await strict_1.default.rejects(() => t.prisma.$executeRawUnsafe(`TRUNCATE "AuditEvent"`), /append-only/);
        const again = await t.prisma.auditEvent.findFirstOrThrow({ where: { id: evt.id } });
        strict_1.default.equal(again.action, evt.action);
    });
    (0, node_test_1.it)("audit events carry tenant, facility, actor and request id", async () => {
        const r = await t.api("post", "/roles", tenant.admin.token).set("x-request-id", "audit-req-0001").send({ name: "Trace Role", permissions: ["PATIENT_READ"] });
        strict_1.default.equal(r.status, 201);
        const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.tenantId, action: "ROLE_CREATED", entityId: r.body.data.id } });
        strict_1.default.equal(evt.actorUserId, tenant.admin.id);
        strict_1.default.equal(evt.facilityId, tenant.facilityId);
        strict_1.default.equal(evt.requestId, "audit-req-0001");
    });
    (0, node_test_1.it)("audit listing requires AUDIT_READ, is paginated, filterable and read-only", async () => {
        const list = await t.api("get", "/audit-events", tenant.admin.token).query({ action: "ROLE_CREATED" });
        strict_1.default.equal(list.status, 200);
        strict_1.default.ok(list.body.data.every((e) => e.action === "ROLE_CREATED"));
        for (const m of ["post", "put", "patch", "delete"]) {
            const r = await t.api(m, "/audit-events", tenant.admin.token).send({});
            strict_1.default.ok([404, 405].includes(r.status), `${m} must not exist`);
        }
        strict_1.default.equal((await t.api("get", "/audit-events", tenant.admin.token).query({ pageSize: 500 })).status, 400);
    });
});
//# sourceMappingURL=platform.spec.js.map