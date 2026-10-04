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
const jwt = __importStar(require("jsonwebtoken"));
const harness_1 = require("../../test/harness");
(0, node_test_1.describe)("authentication", () => {
    let t;
    let tenant;
    (0, node_test_1.before)(async () => {
        t = await (0, harness_1.startApp)();
        tenant = await t.makeTenant("auth");
    });
    (0, node_test_1.after)(async () => { await t.close(); });
    (0, node_test_1.it)("logs in with valid credentials and returns a token pair; me reflects server-derived context", async () => {
        const r = await t.login(tenant.code, "admin", harness_1.PASSWORD, tenant.facilityId);
        strict_1.default.equal(r.status, 200);
        strict_1.default.equal(r.body.data.status, "AUTHENTICATED");
        strict_1.default.ok(r.body.data.tokens.accessToken);
        strict_1.default.ok(r.body.data.tokens.refreshToken);
        const me = await t.api("get", "/auth/me", r.body.data.tokens.accessToken);
        strict_1.default.equal(me.status, 200);
        strict_1.default.equal(me.body.data.tenant.id, tenant.tenantId);
        strict_1.default.equal(me.body.data.facility.id, tenant.facilityId);
        strict_1.default.ok(me.body.data.permissions.includes("ADMIN_USERS"));
    });
    (0, node_test_1.it)("stores only a hash of the password and refresh token", async () => {
        const u = await t.prisma.user.findFirstOrThrow({ where: { tenantId: tenant.tenantId, username: "admin" } });
        strict_1.default.match(u.passwordHash, /^scrypt\$/);
        strict_1.default.ok(!u.passwordHash.includes(harness_1.PASSWORD));
        const login = await t.login(tenant.code, "admin", harness_1.PASSWORD, tenant.facilityId);
        const rt = login.body.data.tokens.refreshToken;
        const rows = await t.prisma.refreshToken.findMany({ where: { tenantId: tenant.tenantId } });
        strict_1.default.ok(rows.every((x) => x.tokenHash !== rt));
    });
    (0, node_test_1.it)("returns an identical generic error for unknown tenant, unknown user and wrong password", async () => {
        const a = await t.login("no-such-tenant", "admin");
        const b = await t.login(tenant.code, "nobody");
        const c = await t.login(tenant.code, "admin", "Wrong-Password-1");
        for (const r of [a, b, c]) {
            strict_1.default.equal(r.status, 401);
            strict_1.default.equal(r.body.error.code, "INVALID_CREDENTIALS");
        }
        strict_1.default.equal(a.body.error.message, b.body.error.message);
        strict_1.default.equal(b.body.error.message, c.body.error.message);
    });
    (0, node_test_1.it)("rejects malformed login input with a validation error and unknown fields", async () => {
        const r = await t.http().post("/api/v1/auth/login").send({ tenantCode: tenant.code, identifier: "admin", password: harness_1.PASSWORD, role: "ADMIN" });
        strict_1.default.equal(r.status, 400);
        strict_1.default.equal(r.body.error.code, "VALIDATION_FAILED");
        const r2 = await t.http().post("/api/v1/auth/login").send({ tenantCode: tenant.code });
        strict_1.default.equal(r2.status, 400);
    });
    (0, node_test_1.it)("rejects inactive users at login and invalidates their existing access token immediately", async () => {
        const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
        strict_1.default.equal((await t.api("get", "/auth/me", u.token)).status, 200);
        const off = await t.api("patch", `/users/${u.id}`, tenant.admin.token).send({ status: "INACTIVE" });
        strict_1.default.equal(off.status, 200);
        strict_1.default.equal((await t.api("get", "/auth/me", u.token)).status, 401);
        const r = await t.login(tenant.code, u.username);
        strict_1.default.equal(r.status, 401);
        strict_1.default.equal(r.body.error.code, "INVALID_CREDENTIALS");
    });
    (0, node_test_1.it)("rejects users of an inactive tenant", async () => {
        const t2 = await t.makeTenant("inact");
        await t.prisma.tenant.update({ where: { id: t2.tenantId }, data: { status: "INACTIVE" } });
        strict_1.default.equal((await t.api("get", "/auth/me", t2.admin.token)).status, 401);
        strict_1.default.equal((await t.login(t2.code, "admin")).status, 401);
    });
    (0, node_test_1.it)("locks the account after repeated failures, even for the correct password", async () => {
        const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
        for (let i = 0; i < 5; i++)
            strict_1.default.equal((await t.login(tenant.code, u.username, "Bad-Password-9")).status, 401);
        const locked = await t.login(tenant.code, u.username, harness_1.PASSWORD);
        strict_1.default.equal(locked.status, 401);
        const row = await t.prisma.user.findFirstOrThrow({ where: { id: u.id } });
        strict_1.default.ok(row.lockedUntil && row.lockedUntil > new Date());
    });
    (0, node_test_1.it)("requires facility selection when the user has several facilities, and never trusts a foreign facility id", async () => {
        const r = await t.login(tenant.code, "admin");
        strict_1.default.equal(r.status, 200);
        strict_1.default.equal(r.body.data.status, "FACILITY_SELECTION_REQUIRED");
        strict_1.default.equal(r.body.data.facilities.length, 2);
        strict_1.default.equal(r.body.data.tokens, undefined);
        const other = await t.makeTenant("other");
        const foreign = await t.login(tenant.code, "admin", harness_1.PASSWORD, other.facilityId);
        strict_1.default.equal(foreign.status, 403);
        strict_1.default.equal(foreign.body.error.code, "UNAUTHORIZED_FACILITY");
    });
    (0, node_test_1.it)("rotates refresh tokens, detects reuse of a rotated token and revokes the whole family", async () => {
        const l = await t.login(tenant.code, "admin", harness_1.PASSWORD, tenant.facilityId);
        const rt1 = l.body.data.tokens.refreshToken;
        const r1 = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt1 });
        strict_1.default.equal(r1.status, 200);
        const rt2 = r1.body.data.refreshToken;
        strict_1.default.notEqual(rt1, rt2);
        const replay = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt1 });
        strict_1.default.equal(replay.status, 401);
        strict_1.default.equal(replay.body.error.code, "TOKEN_REVOKED");
        const afterTheft = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt2 });
        strict_1.default.equal(afterTheft.status, 401, "rotated successor must be dead after reuse detection");
        const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: tenant.tenantId, action: "REFRESH_TOKEN_REUSE_DETECTED" } });
        strict_1.default.ok(evt);
    });
    (0, node_test_1.it)("allows exactly one winner when the same refresh token is used concurrently", async () => {
        const l = await t.login(tenant.code, "admin", harness_1.PASSWORD, tenant.facilityId);
        const rt = l.body.data.tokens.refreshToken;
        const results = await Promise.all(Array.from({ length: 6 }, () => t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })));
        strict_1.default.equal(results.filter((r) => r.status === 200).length, 1);
        strict_1.default.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 401));
    });
    (0, node_test_1.it)("logout revokes the session, is idempotent, and is audited", async () => {
        const l = await t.login(tenant.code, "admin", harness_1.PASSWORD, tenant.facilityId);
        const rt = l.body.data.tokens.refreshToken;
        strict_1.default.equal((await t.http().post("/api/v1/auth/logout").send({ refreshToken: rt })).status, 204);
        strict_1.default.equal((await t.http().post("/api/v1/auth/logout").send({ refreshToken: rt })).status, 204);
        strict_1.default.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })).status, 401);
        const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: tenant.tenantId, action: "LOGOUT" } });
        strict_1.default.ok(evt);
    });
    (0, node_test_1.it)("switch-facility issues a new session scoped to an accessible facility only", async () => {
        const l = await t.login(tenant.code, "admin", harness_1.PASSWORD, tenant.facilityId);
        const { accessToken, refreshToken } = l.body.data.tokens;
        const sw = await t.api("post", "/auth/switch-facility", accessToken).send({ refreshToken, facilityId: tenant.facility2Id });
        strict_1.default.equal(sw.status, 200);
        const me = await t.api("get", "/auth/me", sw.body.data.accessToken);
        strict_1.default.equal(me.body.data.facility.id, tenant.facility2Id);
        strict_1.default.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken })).status, 401, "old session revoked");
        const other = await t.makeTenant("sw");
        const bad = await t.api("post", "/auth/switch-facility", sw.body.data.accessToken).send({ refreshToken: sw.body.data.refreshToken, facilityId: other.facilityId });
        strict_1.default.equal(bad.status, 403);
    });
    (0, node_test_1.it)("rejects missing, malformed, tampered, wrong-algorithm and expired tokens identically", async () => {
        const good = tenant.admin.token;
        const payload = jwt.decode(good);
        const forged = jwt.sign({ typ: "access", tid: payload["tid"], fid: payload["fid"] }, "wrong-secret-wrong-secret-wrong-secret", { subject: payload.sub, expiresIn: 60 });
        const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: payload.sub, tid: payload["tid"], fid: payload["fid"], typ: "access" })).toString("base64url")}.`;
        const expired = jwt.sign({ typ: "access", tid: payload["tid"], fid: payload["fid"] }, process.env["JWT_ACCESS_SECRET"], { subject: payload.sub, expiresIn: -10 });
        const refreshAsAccess = jwt.sign({ typ: "refresh", tid: payload["tid"], fid: payload["fid"] }, process.env["JWT_ACCESS_SECRET"], { subject: payload.sub, expiresIn: 60 });
        for (const bad of [undefined, "garbage", forged, none, expired, refreshAsAccess, `${good}x`]) {
            const r = await t.api("get", "/auth/me", bad);
            strict_1.default.equal(r.status, 401, String(bad).slice(0, 30));
            strict_1.default.equal(r.body.error.code, "UNAUTHENTICATED");
        }
    });
    (0, node_test_1.it)("changes own password with the current password, revokes sessions, and audits without secrets", async () => {
        const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
        const l = await t.login(tenant.code, u.username);
        const rt = l.body.data.tokens.refreshToken;
        const wrong = await t.api("post", "/users/me/password", u.token).send({ currentPassword: "Nope-Nope-1", newPassword: "New-Passw0rd-xyz" });
        strict_1.default.equal(wrong.status, 400);
        const ok = await t.api("post", "/users/me/password", u.token).send({ currentPassword: harness_1.PASSWORD, newPassword: "New-Passw0rd-xyz" });
        strict_1.default.equal(ok.status, 204);
        strict_1.default.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })).status, 401);
        strict_1.default.equal((await t.login(tenant.code, u.username, "New-Passw0rd-xyz")).status, 200);
        const weak = await t.api("post", "/users/me/password", u.token).send({ currentPassword: "New-Passw0rd-xyz", newPassword: "short" });
        strict_1.default.equal(weak.status, 400);
        const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, actorUserId: u.id, action: "PASSWORD_CHANGED" } });
        strict_1.default.equal(evts.length, 1);
        strict_1.default.ok(!JSON.stringify(evts[0]).includes("Passw0rd"));
    });
    (0, node_test_1.it)("audits login success and failure without leaking secrets", async () => {
        await t.login(tenant.code, "admin", "Wrong-Password-1", tenant.facilityId);
        await t.login(tenant.code, "admin", harness_1.PASSWORD, tenant.facilityId);
        const events = await t.prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, action: { in: ["LOGIN_FAILED", "LOGIN_SUCCESS"] } } });
        strict_1.default.ok(events.some((e) => e.action === "LOGIN_FAILED"));
        strict_1.default.ok(events.some((e) => e.action === "LOGIN_SUCCESS"));
        const blob = JSON.stringify(events);
        strict_1.default.ok(!blob.includes(harness_1.PASSWORD) && !blob.includes("Wrong-Password-1"));
    });
});
(0, node_test_1.describe)("authentication rate limiting", () => {
    let t;
    (0, node_test_1.before)(async () => { t = await (0, harness_1.startApp)({ rateLimit: true }); });
    (0, node_test_1.after)(async () => { await t.close(); });
    (0, node_test_1.it)("throttles repeated login attempts with 429 RATE_LIMITED", async () => {
        let last = 0;
        let code = "";
        for (let i = 0; i < 14; i++) {
            const r = await t.login("whatever-tenant", "someone", "Whatever-123");
            last = r.status;
            if (r.status === 429) {
                code = r.body.error.code;
                break;
            }
        }
        strict_1.default.equal(last, 429);
        strict_1.default.equal(code, "RATE_LIMITED");
    });
});
//# sourceMappingURL=auth.spec.js.map