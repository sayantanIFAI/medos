"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_crypto_1 = require("node:crypto");
const harness_1 = require("../../test/harness");
(0, node_test_1.describe)("tenant and facility isolation", () => {
    let t;
    let a;
    let b;
    (0, node_test_1.before)(async () => {
        t = await (0, harness_1.startApp)();
        a = await t.makeTenant("iso-a");
        b = await t.makeTenant("iso-b");
    });
    (0, node_test_1.after)(async () => { await t.close(); });
    (0, node_test_1.it)("cross-tenant facility reads look exactly like non-existent ids (no existence oracle)", async () => {
        const cross = await t.api("get", `/facilities/${b.facilityId}`, a.admin.token);
        const missing = await t.api("get", `/facilities/${(0, node_crypto_1.randomUUID)()}`, a.admin.token);
        const malformed = await t.api("get", "/facilities/not-a-uuid", a.admin.token);
        for (const r of [cross, missing]) {
            strict_1.default.equal(r.status, 404);
            strict_1.default.equal(r.body.error.code, "FACILITY_NOT_FOUND");
        }
        strict_1.default.equal(cross.body.error.message, missing.body.error.message);
        strict_1.default.equal(malformed.status, 404);
    });
    (0, node_test_1.it)("cross-tenant facility update is rejected and leaves the foreign record untouched", async () => {
        const r = await t.api("patch", `/facilities/${b.facilityId}`, a.admin.token).send({ name: "Hijacked" });
        strict_1.default.equal(r.status, 404);
        const f = await t.prisma.facility.findFirstOrThrow({ where: { id: b.facilityId } });
        strict_1.default.notEqual(f.name, "Hijacked");
    });
    (0, node_test_1.it)("cross-tenant user access (read, update, roles, facilities, password reset) is not found", async () => {
        const victim = await t.makeUser(b, ["RECEPTIONIST"]);
        const tok = a.admin.token;
        strict_1.default.equal((await t.api("get", `/users/${victim.id}`, tok)).status, 404);
        strict_1.default.equal((await t.api("patch", `/users/${victim.id}`, tok).send({ status: "INACTIVE" })).status, 404);
        strict_1.default.equal((await t.api("put", `/users/${victim.id}/roles`, tok).send({ roleIds: [a.roleIds["DOCTOR"]] })).status, 404);
        strict_1.default.equal((await t.api("put", `/users/${victim.id}/facilities`, tok).send({ facilityIds: [a.facilityId] })).status, 404);
        strict_1.default.equal((await t.api("post", `/users/${victim.id}/reset-password`, tok).send({ password: "Taken-Over-123" })).status, 404);
        const still = await t.prisma.user.findFirstOrThrow({ where: { id: victim.id } });
        strict_1.default.equal(still.status, "ACTIVE");
    });
    (0, node_test_1.it)("cannot attach another tenant's roles or facilities when creating or editing users", async () => {
        const withForeignRole = await t.api("post", "/users", a.admin.token).send({
            username: "evil1", fullName: "Evil One", password: "Valid-Passw0rd-1", roleIds: [b.roleIds["ADMINISTRATOR"]], facilityIds: [a.facilityId],
        });
        strict_1.default.equal(withForeignRole.status, 400);
        const withForeignFacility = await t.api("post", "/users", a.admin.token).send({
            username: "evil2", fullName: "Evil Two", password: "Valid-Passw0rd-1", roleIds: [a.roleIds["RECEPTIONIST"]], facilityIds: [b.facilityId],
        });
        strict_1.default.equal(withForeignFacility.status, 400);
        strict_1.default.equal(await t.prisma.user.count({ where: { username: { in: ["evil1", "evil2"] } } }), 0);
    });
    (0, node_test_1.it)("the database itself rejects cross-tenant relations (composite foreign keys)", async () => {
        const victim = await t.makeUser(b, ["RECEPTIONIST"]);
        await strict_1.default.rejects(() => t.prisma.userRole.create({ data: { tenantId: a.tenantId, userId: victim.id, roleId: a.roleIds["DOCTOR"] } }));
        await strict_1.default.rejects(() => t.prisma.userFacility.create({ data: { tenantId: a.tenantId, userId: a.admin.id, facilityId: b.facilityId } }));
    });
    (0, node_test_1.it)("ignores client-supplied tenant/facility identifiers (strict bodies, headers and query)", async () => {
        const body = await t.api("post", "/facilities", a.admin.token).send({ name: "Sneaky", code: "SNK1", tenantId: b.tenantId });
        strict_1.default.equal(body.status, 400);
        strict_1.default.equal(body.body.error.code, "VALIDATION_FAILED");
        const hdr = await t.api("get", "/facilities", a.admin.token).set("X-Tenant-Id", b.tenantId).set("X-Facility-Id", b.facilityId).query({ tenantId: b.tenantId });
        strict_1.default.equal(hdr.status, 200);
        strict_1.default.ok(hdr.body.data.every((f) => f.id !== b.facilityId), "foreign tenant/facility hints are ignored");
    });
    (0, node_test_1.it)("lists only the caller's tenant data (facilities, users, audit events, roles)", async () => {
        const facilities = await t.api("get", "/facilities", a.admin.token);
        strict_1.default.ok(facilities.body.data.every((f) => [a.facilityId, a.facility2Id].includes(f.id)));
        const users = await t.api("get", "/users", a.admin.token);
        strict_1.default.ok(users.body.data.length >= 1);
        const ids = new Set((await t.prisma.user.findMany({ where: { tenantId: a.tenantId } })).map((u) => u.id));
        strict_1.default.ok(users.body.data.every((u) => ids.has(u.id)));
        const audit = await t.api("get", "/audit-events", a.admin.token).query({ pageSize: 100 });
        strict_1.default.ok(audit.body.data.length > 0);
        const foreign = await t.prisma.auditEvent.findMany({ where: { tenantId: b.tenantId }, select: { id: true } });
        const foreignIds = new Set(foreign.map((e) => e.id));
        strict_1.default.ok(audit.body.data.every((e) => !foreignIds.has(e.id)));
        const roles = await t.api("get", "/roles", a.admin.token);
        const foreignRoles = new Set(Object.values(b.roleIds));
        strict_1.default.ok(roles.body.data.every((r) => !foreignRoles.has(r.id)));
    });
    (0, node_test_1.it)("enforces facility access: users only see and switch into their own facilities", async () => {
        const rec = await t.makeUser(a, ["RECEPTIONIST"], { facilityIds: [a.facilityId] });
        const list = await t.api("get", "/facilities", rec.token);
        strict_1.default.deepEqual(list.body.data.map((f) => f.id), [a.facilityId]);
        strict_1.default.equal((await t.api("get", `/facilities/${a.facility2Id}`, rec.token)).status, 404);
        strict_1.default.equal((await t.api("patch", `/facilities/${a.facilityId}`, rec.token).send({ name: "x1" })).status, 403);
    });
    (0, node_test_1.it)("revoking facility access takes effect on already-issued tokens", async () => {
        const u = await t.makeUser(a, ["RECEPTIONIST"], { facilityIds: [a.facilityId, a.facility2Id] });
        strict_1.default.equal((await t.api("get", "/auth/me", u.token)).status, 200);
        const r = await t.api("put", `/users/${u.id}/facilities`, a.admin.token).send({ facilityIds: [a.facility2Id] });
        strict_1.default.equal(r.status, 200);
        const after = await t.api("get", "/auth/me", u.token);
        strict_1.default.equal(after.status, 403);
        strict_1.default.equal(after.body.error.code, "UNAUTHORIZED_FACILITY");
    });
    (0, node_test_1.it)("validates facility input, keeps codes unique per tenant, and allows same code in another tenant", async () => {
        const bad = await t.api("post", "/facilities", a.admin.token).send({ name: "X", code: "lower case" });
        strict_1.default.equal(bad.status, 400);
        const badGst = await t.api("post", "/facilities", a.admin.token).send({ name: "Gst Test", code: "GST1", gstin: "NOTAGSTIN" });
        strict_1.default.equal(badGst.status, 400);
        const ok = await t.api("post", "/facilities", a.admin.token).send({ name: "Branch One", code: "BR1", gstin: "19ABCDE1234F1Z5", postalCode: "700001", phone: "+91 98300 00000" });
        strict_1.default.equal(ok.status, 201);
        const dup = await t.api("post", "/facilities", a.admin.token).send({ name: "Branch Dup", code: "BR1" });
        strict_1.default.equal(dup.status, 409);
        strict_1.default.equal(dup.body.error.code, "CONFLICT");
        const otherTenant = await t.api("post", "/facilities", b.admin.token).send({ name: "Branch One B", code: "BR1" });
        strict_1.default.equal(otherTenant.status, 201);
    });
    (0, node_test_1.it)("refuses to deactivate the facility the caller is working in, and audits facility changes", async () => {
        const self = await t.api("patch", `/facilities/${a.facilityId}`, a.admin.token).send({ status: "INACTIVE" });
        strict_1.default.equal(self.status, 409);
        const ok = await t.api("patch", `/facilities/${a.facility2Id}`, a.admin.token).send({ status: "INACTIVE" });
        strict_1.default.equal(ok.status, 200);
        const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "FACILITY_STATUS_CHANGED", entityId: a.facility2Id } });
        strict_1.default.ok(evt && evt.actorUserId === a.admin.id);
    });
    (0, node_test_1.it)("tenant settings: only the administrator can update; timezone validated; audited", async () => {
        const rec = await t.makeUser(a, ["RECEPTIONIST"]);
        strict_1.default.equal((await t.api("patch", "/tenants/current", rec.token).send({ name: "Nope Hospital" })).status, 403);
        strict_1.default.equal((await t.api("patch", "/tenants/current", a.admin.token).send({ timezone: "Mars/Olympus" })).status, 400);
        strict_1.default.equal((await t.api("patch", "/tenants/current", a.admin.token).send({ code: "newcode" })).status, 400, "code is immutable");
        const ok = await t.api("patch", "/tenants/current", a.admin.token).send({ name: "Renamed Hospital" });
        strict_1.default.equal(ok.status, 200);
        strict_1.default.equal(ok.body.data.name, "Renamed Hospital");
        const bUntouched = await t.api("get", "/tenants/current", b.admin.token);
        strict_1.default.notEqual(bUntouched.body.data.name, "Renamed Hospital");
        strict_1.default.ok(await t.prisma.auditEvent.findFirst({ where: { tenantId: a.tenantId, action: "TENANT_UPDATED" } }));
    });
    (0, node_test_1.it)("provisioning is atomic: a duplicate tenant code leaves no partial data", async () => {
        const before = await t.prisma.user.count();
        const { TenantsService } = await Promise.resolve().then(() => __importStar(require("./tenants.service")));
        const svc = t.app.get(TenantsService);
        await strict_1.default.rejects(() => svc.provision({
            tenant: { name: "Dup Hospital", code: a.code, timezone: "Asia/Kolkata" },
            facility: { name: "Dup", code: "DUP1" },
            admin: { username: "dupadmin", fullName: "Dup Admin", password: "Valid-Passw0rd-1" },
        }));
        strict_1.default.equal(await t.prisma.user.count(), before);
    });
});
//# sourceMappingURL=tenancy.spec.js.map