"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const shared_1 = require("@medos/shared");
const app_module_1 = require("../../app.module");
const http_1 = require("../../common/http");
const harness_1 = require("../../test/harness");
(0, node_test_1.describe)("route access policy", () => {
    (0, node_test_1.it)("every route explicitly declares public, any-authenticated or required permissions", () => {
        const undeclared = [];
        let routes = 0;
        for (const C of app_module_1.CONTROLLERS) {
            const proto = C.prototype;
            for (const name of Object.getOwnPropertyNames(proto)) {
                const handler = proto[name];
                if (name === "constructor" || typeof handler !== "function")
                    continue;
                if (Reflect.getMetadata("method", handler) === undefined)
                    continue; // not a route
                routes++;
                const declared = Reflect.getMetadata(http_1.IS_PUBLIC, handler) === true ||
                    Reflect.getMetadata(http_1.ANY_AUTHENTICATED, handler) === true ||
                    Reflect.getMetadata(http_1.REQUIRED_PERMISSIONS, handler)?.length;
                if (!declared)
                    undeclared.push(`${C.name}.${name}`);
            }
        }
        strict_1.default.ok(routes > 15, "route scan must actually find routes");
        strict_1.default.deepEqual(undeclared, []);
    });
    (0, node_test_1.it)("system roles only reference known permissions", () => {
        const known = new Set(shared_1.PERMISSIONS);
        for (const [role, perms] of Object.entries(shared_1.SYSTEM_ROLES)) {
            for (const p of perms)
                strict_1.default.ok(known.has(p), `${role} -> ${p}`);
        }
    });
});
(0, node_test_1.describe)("RBAC enforcement", () => {
    let t;
    let tenant;
    (0, node_test_1.before)(async () => {
        t = await (0, harness_1.startApp)();
        tenant = await t.makeTenant("rbac");
    });
    (0, node_test_1.after)(async () => { await t.close(); });
    (0, node_test_1.it)("denies admin-only endpoints to non-admin roles with FORBIDDEN, and unauthenticated callers with 401", async () => {
        const rec = await t.makeUser(tenant, ["RECEPTIONIST"]);
        const doc = await t.makeUser(tenant, ["DOCTOR"]);
        const adminOnly = [
            ["get", "/users"], ["post", "/users"], ["get", "/roles"], ["post", "/roles"],
            ["get", "/audit-events"], ["get", "/number-sequences"], ["post", "/facilities"],
            ["patch", "/tenants/current"],
        ];
        for (const [m, p] of adminOnly) {
            for (const u of [rec, doc]) {
                const r = await t.api(m, p, u.token).send({});
                strict_1.default.equal(r.status, 403, `${m} ${p}`);
                strict_1.default.equal(r.body.error.code, "FORBIDDEN");
            }
            strict_1.default.equal((await t.api(m, p).send({})).status, 401, `${m} ${p} unauthenticated`);
        }
    });
    (0, node_test_1.it)("applies a role permission change to already-issued tokens immediately", async () => {
        const role = await t.api("post", "/roles", tenant.admin.token).send({ name: "Audit Viewer", permissions: ["AUDIT_READ"] });
        strict_1.default.equal(role.status, 201);
        const u = await t.makeUser(tenant, []);
        const grant = await t.api("put", `/users/${u.id}/roles`, tenant.admin.token).send({ roleIds: [role.body.data.id] });
        strict_1.default.equal(grant.status, 200);
        strict_1.default.equal((await t.api("get", "/audit-events", u.token)).status, 200);
        const revoke = await t.api("put", `/roles/${role.body.data.id}/permissions`, tenant.admin.token).send({ permissions: ["REPORT_READ"] });
        strict_1.default.equal(revoke.status, 200);
        strict_1.default.equal((await t.api("get", "/audit-events", u.token)).status, 403);
    });
    (0, node_test_1.it)("rejects unknown permissions and protects system roles from modification", async () => {
        strict_1.default.equal((await t.api("post", "/roles", tenant.admin.token).send({ name: "Bogus", permissions: ["GOD_MODE"] })).status, 400);
        const sys = await t.api("put", `/roles/${tenant.roleIds["RECEPTIONIST"]}/permissions`, tenant.admin.token).send({ permissions: ["ADMIN_USERS"] });
        strict_1.default.equal(sys.status, 409);
        const dup = await t.api("post", "/roles", tenant.admin.token).send({ name: "RECEPTIONIST", permissions: ["PATIENT_READ"] });
        strict_1.default.equal(dup.status, 409);
    });
    (0, node_test_1.it)("prevents privilege self-escalation: administrators cannot change their own roles, facilities, status or password via admin routes", async () => {
        const ownId = tenant.admin.id;
        const tok = tenant.admin.token;
        strict_1.default.equal((await t.api("put", `/users/${ownId}/roles`, tok).send({ roleIds: [tenant.roleIds["DOCTOR"]] })).status, 409);
        strict_1.default.equal((await t.api("put", `/users/${ownId}/facilities`, tok).send({ facilityIds: [tenant.facilityId] })).status, 409);
        strict_1.default.equal((await t.api("patch", `/users/${ownId}`, tok).send({ status: "INACTIVE" })).status, 409);
        strict_1.default.equal((await t.api("post", `/users/${ownId}/reset-password`, tok).send({ password: "Another-Passw0rd-1" })).status, 409);
    });
    (0, node_test_1.it)("blocks mass assignment: protected fields cannot be set through user/role/facility endpoints", async () => {
        const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
        for (const evil of [{ passwordHash: "x" }, { tenantId: "x" }, { id: "x" }, { failedLoginCount: 0 }, { isSystem: true }]) {
            const r = await t.api("patch", `/users/${u.id}`, tenant.admin.token).send({ fullName: "Ok Name", ...evil });
            strict_1.default.equal(r.status, 400, JSON.stringify(evil));
        }
        const role = await t.api("post", "/roles", tenant.admin.token).send({ name: "Mass Assign", permissions: ["PATIENT_READ"], isSystem: true });
        strict_1.default.equal(role.status, 400);
    });
    (0, node_test_1.it)("creates users with roles and facilities, enforces the password policy, and the new user can log in", async () => {
        const weak = await t.api("post", "/users", tenant.admin.token).send({ username: "weak1", fullName: "Weak One", password: "short", roleIds: [tenant.roleIds["NURSE"]], facilityIds: [tenant.facilityId] });
        strict_1.default.equal(weak.status, 400);
        const noDigits = await t.api("post", "/users", tenant.admin.token).send({ username: "weak2", fullName: "Weak Two", password: "onlyletterslong", roleIds: [tenant.roleIds["NURSE"]], facilityIds: [tenant.facilityId] });
        strict_1.default.equal(noDigits.status, 400);
        const ok = await t.api("post", "/users", tenant.admin.token).send({
            username: "nurse.priya", fullName: "Priya Das", email: "Priya@Example.test", password: harness_1.PASSWORD, roleIds: [tenant.roleIds["NURSE"]], facilityIds: [tenant.facilityId],
        });
        strict_1.default.equal(ok.status, 201);
        strict_1.default.equal(ok.body.data.email, "priya@example.test");
        strict_1.default.equal(ok.body.data.passwordHash, undefined, "password hash must never be returned");
        const login = await t.login(tenant.code, "nurse.priya", harness_1.PASSWORD);
        strict_1.default.equal(login.status, 200);
        const dup = await t.api("post", "/users", tenant.admin.token).send({ username: "nurse.priya", fullName: "Dup", password: harness_1.PASSWORD, roleIds: [tenant.roleIds["NURSE"]], facilityIds: [tenant.facilityId] });
        strict_1.default.equal(dup.status, 409);
    });
    (0, node_test_1.it)("audits permission changes with the acting user and before/after state", async () => {
        const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
        await t.api("put", `/users/${u.id}/roles`, tenant.admin.token).send({ roleIds: [tenant.roleIds["CASHIER"]] });
        const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.tenantId, action: "USER_ROLES_CHANGED", entityId: u.id } });
        strict_1.default.equal(evt.actorUserId, tenant.admin.id);
        const meta = evt.metadata;
        strict_1.default.deepEqual(meta.before, [tenant.roleIds["RECEPTIONIST"]]);
        strict_1.default.deepEqual(meta.after, [tenant.roleIds["CASHIER"]]);
    });
    (0, node_test_1.it)("deactivating a user revokes their refresh tokens; password reset revokes sessions and unlocks", async () => {
        const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
        const l = await t.login(tenant.code, u.username);
        const rt = l.body.data.tokens.refreshToken;
        await t.api("post", `/users/${u.id}/reset-password`, tenant.admin.token).send({ password: "Reset-Passw0rd-77" });
        strict_1.default.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })).status, 401);
        strict_1.default.equal((await t.login(tenant.code, u.username, "Reset-Passw0rd-77")).status, 200);
        const l2 = await t.login(tenant.code, u.username, "Reset-Passw0rd-77");
        await t.api("patch", `/users/${u.id}`, tenant.admin.token).send({ status: "INACTIVE" });
        strict_1.default.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: l2.body.data.tokens.refreshToken })).status, 401);
    });
    (0, node_test_1.it)("paginates and filters the user list within bounds", async () => {
        const r = await t.api("get", "/users", tenant.admin.token).query({ page: 1, pageSize: 2 });
        strict_1.default.equal(r.status, 200);
        strict_1.default.ok(r.body.data.length <= 2);
        strict_1.default.ok(r.body.meta.total >= r.body.data.length);
        strict_1.default.equal((await t.api("get", "/users", tenant.admin.token).query({ pageSize: 1000 })).status, 400);
        const s = await t.api("get", "/users", tenant.admin.token).query({ q: "Synthetic Admin" });
        strict_1.default.ok(s.body.data.some((u) => u.username === "admin"));
    });
});
//# sourceMappingURL=rbac.spec.js.map