import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as jwt from "jsonwebtoken";
import { PASSWORD, startApp, type TestApp, type TestTenant } from "../../test/harness";

describe("authentication", () => {
  let t: TestApp;
  let tenant: TestTenant;

  before(async () => {
    t = await startApp();
    tenant = await t.makeTenant("auth");
  });
  after(async () => { await t.close(); });

  it("logs in with valid credentials and returns a token pair; me reflects server-derived context", async () => {
    const r = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, "AUTHENTICATED");
    assert.ok(r.body.data.tokens.accessToken);
    assert.ok(r.body.data.tokens.refreshToken);
    const me = await t.api("get", "/auth/me", r.body.data.tokens.accessToken);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.tenant.id, tenant.tenantId);
    assert.equal(me.body.data.facility.id, tenant.facilityId);
    assert.ok(me.body.data.permissions.includes("ADMIN_USERS"));
  });

  it("stores only a hash of the password and refresh token", async () => {
    const u = await t.prisma.user.findFirstOrThrow({ where: { tenantId: tenant.tenantId, username: "admin" } });
    assert.match(u.passwordHash, /^scrypt\$/);
    assert.ok(!u.passwordHash.includes(PASSWORD));
    const login = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const rt = login.body.data.tokens.refreshToken as string;
    const rows = await t.prisma.refreshToken.findMany({ where: { tenantId: tenant.tenantId } });
    assert.ok(rows.every((x) => x.tokenHash !== rt));
  });

  it("returns an identical generic error for unknown tenant, unknown user and wrong password", async () => {
    const a = await t.login("no-such-tenant", "admin");
    const b = await t.login(tenant.code, "nobody");
    const c = await t.login(tenant.code, "admin", "Wrong-Password-1");
    for (const r of [a, b, c]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, "INVALID_CREDENTIALS");
    }
    assert.equal(a.body.error.message, b.body.error.message);
    assert.equal(b.body.error.message, c.body.error.message);
  });

  it("rejects malformed login input with a validation error and unknown fields", async () => {
    const r = await t.http().post("/api/v1/auth/login").send({ tenantCode: tenant.code, identifier: "admin", password: PASSWORD, role: "ADMIN" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "VALIDATION_FAILED");
    const r2 = await t.http().post("/api/v1/auth/login").send({ tenantCode: tenant.code });
    assert.equal(r2.status, 400);
  });

  it("rejects inactive users at login and invalidates their existing access token immediately", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    assert.equal((await t.api("get", "/auth/me", u.token)).status, 200);
    const off = await t.api("patch", `/users/${u.id}`, tenant.admin.token).send({ status: "INACTIVE" });
    assert.equal(off.status, 200);
    assert.equal((await t.api("get", "/auth/me", u.token)).status, 401);
    const r = await t.login(tenant.code, u.username);
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, "INVALID_CREDENTIALS");
  });

  it("rejects users of an inactive tenant", async () => {
    const t2 = await t.makeTenant("inact");
    await t.prisma.tenant.update({ where: { id: t2.tenantId }, data: { status: "INACTIVE" } });
    assert.equal((await t.api("get", "/auth/me", t2.admin.token)).status, 401);
    assert.equal((await t.login(t2.code, "admin")).status, 401);
  });

  it("locks the account after repeated failures, even for the correct password", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    for (let i = 0; i < 5; i++) assert.equal((await t.login(tenant.code, u.username, "Bad-Password-9")).status, 401);
    const locked = await t.login(tenant.code, u.username, PASSWORD);
    assert.equal(locked.status, 401);
    const row = await t.prisma.user.findFirstOrThrow({ where: { id: u.id } });
    assert.ok(row.lockedUntil && row.lockedUntil > new Date());
  });

  it("requires facility selection when the user has several facilities, and never trusts a foreign facility id", async () => {
    const r = await t.login(tenant.code, "admin");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, "FACILITY_SELECTION_REQUIRED");
    assert.equal(r.body.data.facilities.length, 2);
    assert.equal(r.body.data.tokens, undefined);

    const other = await t.makeTenant("other");
    const foreign = await t.login(tenant.code, "admin", PASSWORD, other.facilityId);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, "UNAUTHORIZED_FACILITY");
  });

  it("rotates refresh tokens, detects reuse of a rotated token and revokes the whole family", async () => {
    const l = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const rt1 = l.body.data.tokens.refreshToken as string;
    const r1 = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt1 });
    assert.equal(r1.status, 200);
    const rt2 = r1.body.data.refreshToken as string;
    assert.notEqual(rt1, rt2);
    const replay = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt1 });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, "TOKEN_REVOKED");
    const afterTheft = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt2 });
    assert.equal(afterTheft.status, 401, "rotated successor must be dead after reuse detection");
    const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: tenant.tenantId, action: "REFRESH_TOKEN_REUSE_DETECTED" } });
    assert.ok(evt);
  });

  it("allows exactly one winner when the same refresh token is used concurrently", async () => {
    const l = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const rt = l.body.data.tokens.refreshToken as string;
    const results = await Promise.all(Array.from({ length: 6 }, () => t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 401));
  });

  it("logout revokes the session, is idempotent, and is audited", async () => {
    const l = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const rt = l.body.data.tokens.refreshToken as string;
    assert.equal((await t.http().post("/api/v1/auth/logout").send({ refreshToken: rt })).status, 204);
    assert.equal((await t.http().post("/api/v1/auth/logout").send({ refreshToken: rt })).status, 204);
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })).status, 401);
    const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: tenant.tenantId, action: "LOGOUT" } });
    assert.ok(evt);
  });

  it("switch-facility issues a new session scoped to an accessible facility only", async () => {
    const l = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const { accessToken, refreshToken } = l.body.data.tokens as { accessToken: string; refreshToken: string };
    const sw = await t.api("post", "/auth/switch-facility", accessToken).send({ refreshToken, facilityId: tenant.facility2Id });
    assert.equal(sw.status, 200);
    const me = await t.api("get", "/auth/me", sw.body.data.accessToken);
    assert.equal(me.body.data.facility.id, tenant.facility2Id);
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken })).status, 401, "old session revoked");

    const other = await t.makeTenant("sw");
    const bad = await t.api("post", "/auth/switch-facility", sw.body.data.accessToken).send({ refreshToken: sw.body.data.refreshToken, facilityId: other.facilityId });
    assert.equal(bad.status, 403);
  });

  it("rejects missing, malformed, tampered, wrong-algorithm and expired tokens identically", async () => {
    const good = tenant.admin.token;
    const payload = jwt.decode(good) as jwt.JwtPayload;
    const forged = jwt.sign({ typ: "access", tid: payload["tid"], fid: payload["fid"] }, "wrong-secret-wrong-secret-wrong-secret", { subject: payload.sub, expiresIn: 60 });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: payload.sub, tid: payload["tid"], fid: payload["fid"], typ: "access" })).toString("base64url")}.`;
    const expired = jwt.sign({ typ: "access", tid: payload["tid"], fid: payload["fid"] }, process.env["JWT_ACCESS_SECRET"] as string, { subject: payload.sub, expiresIn: -10 });
    const refreshAsAccess = jwt.sign({ typ: "refresh", tid: payload["tid"], fid: payload["fid"] }, process.env["JWT_ACCESS_SECRET"] as string, { subject: payload.sub, expiresIn: 60 });
    for (const bad of [undefined, "garbage", forged, none, expired, refreshAsAccess, `${good}x`]) {
      const r = await t.api("get", "/auth/me", bad);
      assert.equal(r.status, 401, String(bad).slice(0, 30));
      assert.equal(r.body.error.code, "UNAUTHENTICATED");
    }
  });

  it("changes own password with the current password, revokes sessions, and audits without secrets", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const l = await t.login(tenant.code, u.username);
    const rt = l.body.data.tokens.refreshToken as string;
    const wrong = await t.api("post", "/users/me/password", u.token).send({ currentPassword: "Nope-Nope-1", newPassword: "New-Passw0rd-xyz" });
    assert.equal(wrong.status, 400);
    const ok = await t.api("post", "/users/me/password", u.token).send({ currentPassword: PASSWORD, newPassword: "New-Passw0rd-xyz" });
    assert.equal(ok.status, 204);
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })).status, 401);
    assert.equal((await t.login(tenant.code, u.username, "New-Passw0rd-xyz")).status, 200);
    const weak = await t.api("post", "/users/me/password", u.token).send({ currentPassword: "New-Passw0rd-xyz", newPassword: "short" });
    assert.equal(weak.status, 400);
    const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, actorUserId: u.id, action: "PASSWORD_CHANGED" } });
    assert.equal(evts.length, 1);
    assert.ok(!JSON.stringify(evts[0]).includes("Passw0rd"));
  });

  it("audits login success and failure without leaking secrets", async () => {
    await t.login(tenant.code, "admin", "Wrong-Password-1", tenant.facilityId);
    await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const events = await t.prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, action: { in: ["LOGIN_FAILED", "LOGIN_SUCCESS"] } } });
    assert.ok(events.some((e) => e.action === "LOGIN_FAILED"));
    assert.ok(events.some((e) => e.action === "LOGIN_SUCCESS"));
    const blob = JSON.stringify(events);
    assert.ok(!blob.includes(PASSWORD) && !blob.includes("Wrong-Password-1"));
  });
});

describe("authentication rate limiting", () => {
  let t: TestApp;
  before(async () => { t = await startApp({ rateLimit: true }); });
  after(async () => { await t.close(); });

  it("throttles repeated login attempts with 429 RATE_LIMITED", async () => {
    let last = 0;
    let code = "";
    for (let i = 0; i < 14; i++) {
      const r = await t.login("whatever-tenant", "someone", "Whatever-123");
      last = r.status;
      if (r.status === 429) { code = r.body.error.code as string; break; }
    }
    assert.equal(last, 429);
    assert.equal(code, "RATE_LIMITED");
  });
});
