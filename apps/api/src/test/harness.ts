import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { SYSTEM_ROLES } from "@medos/shared";
import request from "supertest";

const url = process.env["TEST_DATABASE_URL"] ?? "postgresql://medos@127.0.0.1:54329/medos_test";
if (!new URL(url).pathname.replace("/", "").endsWith("_test")) {
  throw new Error("Refusing to run tests against a database whose name does not end with _test");
}
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = url;
process.env["JWT_ACCESS_SECRET"] ??= "test-access-secret-0123456789abcdef-test";
process.env["SCRYPT_LOG_N"] ??= "10";

import { createApp } from "../bootstrap";
import { PrismaService } from "../common/prisma.service";
import { TenantsService } from "../modules/tenants/tenants.service";
import { PasswordService } from "../modules/auth/password.service";

export const PASSWORD = "Synthetic-Pass-123";

export interface TestTenant {
  tenantId: string;
  code: string;
  facilityId: string;
  facility2Id: string;
  admin: { id: string; username: string; token: string };
  roleIds: Record<string, string>;
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  api: (method: "get" | "post" | "put" | "patch" | "delete", path: string, token?: string) => request.Test;
  close: () => Promise<void>;
  makeTenant: (label?: string) => Promise<TestTenant>;
  makeUser: (t: TestTenant, roleNames: string[], opts?: { facilityIds?: string[]; username?: string }) => Promise<{ id: string; username: string; token: string }>;
  login: (tenantCode: string, username: string, password?: string, facilityId?: string) => Promise<request.Response>;
}

export async function startApp(opts: { rateLimit?: boolean } = {}): Promise<TestApp> {
  process.env["RATE_LIMIT_ENABLED"] = opts.rateLimit ? "true" : "false";
  const app = await createApp();
  await app.init();
  const prisma = app.get(PrismaService);
  const tenants = app.get(TenantsService);
  const passwords = app.get(PasswordService);
  const server = app.getHttpServer();

  const api: TestApp["api"] = (method, path, token) => {
    const r = request(server)[method](`/api/v1${path}`);
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };

  const login: TestApp["login"] = (tenantCode, username, password = PASSWORD, facilityId) =>
    request(server).post("/api/v1/auth/login").send({ tenantCode, identifier: username, password, ...(facilityId ? { facilityId } : {}) });

  const tokenFor = async (code: string, username: string, facilityId: string): Promise<string> => {
    const r = await login(code, username, PASSWORD, facilityId);
    if (r.status !== 200 || r.body.data.status !== "AUTHENTICATED") throw new Error(`test login failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data.tokens.accessToken as string;
  };

  const makeTenant: TestApp["makeTenant"] = async (label = "t") => {
    const suffix = randomBytes(4).toString("hex");
    const code = `${label}-${suffix}`.toLowerCase();
    const res = await tenants.provision({
      tenant: { name: `Synthetic Hospital ${code}`, code, timezone: "Asia/Kolkata" },
      facility: { name: "Main Campus", code: `MC${suffix.slice(0, 4).toUpperCase()}`, city: "Kolkata", state: "West Bengal" },
      admin: { username: "admin", fullName: "Synthetic Admin", password: PASSWORD },
    });
    const facility2 = await prisma.facility.create({ data: { tenantId: res.tenantId, name: "Annex", code: `AX${suffix.slice(0, 4).toUpperCase()}` } });
    const roles = await prisma.role.findMany({ where: { tenantId: res.tenantId } });
    const roleIds = Object.fromEntries(roles.map((r) => [r.name, r.id]));
    await prisma.userFacility.create({ data: { tenantId: res.tenantId, userId: res.adminUserId, facilityId: facility2.id } });
    const token = await tokenFor(code, "admin", res.facilityId);
    return { tenantId: res.tenantId, code, facilityId: res.facilityId, facility2Id: facility2.id, admin: { id: res.adminUserId, username: "admin", token }, roleIds };
  };

  const makeUser: TestApp["makeUser"] = async (t, roleNames, o = {}) => {
    const username = o.username ?? `u${randomBytes(4).toString("hex")}`;
    const passwordHash = await passwords.hash(PASSWORD);
    const user = await prisma.user.create({ data: { tenantId: t.tenantId, username, fullName: `Synthetic ${username}`, passwordHash } });
    const facilityIds = o.facilityIds ?? [t.facilityId];
    await prisma.userFacility.createMany({ data: facilityIds.map((facilityId) => ({ tenantId: t.tenantId, userId: user.id, facilityId })) });
    for (const n of roleNames) {
      const roleId = t.roleIds[n];
      if (!roleId || !(n in SYSTEM_ROLES)) throw new Error(`unknown system role ${n}`);
      await prisma.userRole.create({ data: { tenantId: t.tenantId, userId: user.id, roleId } });
    }
    const token = await tokenFor(t.code, username, facilityIds[0] as string);
    return { id: user.id, username, token };
  };

  return {
    app, prisma, api, login, makeTenant, makeUser,
    http: () => request(server),
    close: async () => { await app.close(); },
  };
}

// ───────────── synthetic data builders ─────────────

const LETTERS = "bcdfghjklmnprstvwz";
const VOWELS = "aeiou";
/** A pronounceable, effectively unique synthetic name word so trigram duplicate detection never collides across tests. */
export function uniqueWord(len = 8): string {
  const b = randomBytes(len);
  return Array.from(b, (x, i) => (i % 2 === 0 ? LETTERS[x % LETTERS.length] : VOWELS[x % VOWELS.length])).join("").replace(/^./, (c) => c.toUpperCase());
}
export function randomMobile(): string {
  const digits = Array.from(randomBytes(9), (x) => x % 10).join("");
  return `9${digits}`;
}
export function patientBody(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: uniqueWord(8), lastName: uniqueWord(8), gender: "FEMALE", dateOfBirth: "1990-04-02",
    mobile: randomMobile(), addressLine: "12 Synthetic Lane", city: "Kolkata", district: "Kolkata", state: "West Bengal", postalCode: "700001",
    ...o,
  };
}
export async function registerPatient(t: TestApp, token: string, o: Record<string, unknown> = {}): Promise<{ id: string; mrn: string; version: number }> {
  const r = await t.api("post", "/patients", token).send(patientBody(o));
  if (r.status !== 201) throw new Error(`registerPatient failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string; mrn: string; version: number };
}
export interface TestDoctor { userId: string; token: string; practitionerId: string; departmentId: string }

/** A doctor user with a practitioner record (and a fresh department) at the tenant's primary facility. */
export async function makeDoctor(t: TestApp, tenant: TestTenant, o: { facilityId?: string } = {}): Promise<TestDoctor> {
  const facilityId = o.facilityId ?? tenant.facilityId;
  const user = await t.makeUser(tenant, ["DOCTOR"], { facilityIds: [facilityId] });
  const department = await t.prisma.department.create({ data: { tenantId: tenant.tenantId, facilityId, name: `Dept ${uniqueWord(5)}`, code: `D${randomBytes(3).toString("hex").toUpperCase()}` } });
  const practitioner = await t.prisma.practitioner.create({
    data: { tenantId: tenant.tenantId, facilityId, userId: user.id, departmentId: department.id, displayName: `Dr. ${uniqueWord(6)} ${uniqueWord(7)}`, specialty: "General Medicine" },
  });
  return { userId: user.id, token: user.token, practitionerId: practitioner.id, departmentId: department.id };
}

/** A user whose only role is a custom role holding exactly the listed permissions. */
export async function makeUserWithPermissions(t: TestApp, tenant: TestTenant, permissions: string[]): Promise<{ id: string; token: string }> {
  const role = await t.api("post", "/roles", tenant.admin.token).send({ name: `Custom ${uniqueWord(6)}`, permissions });
  if (role.status !== 201) throw new Error(`role create failed: ${JSON.stringify(role.body)}`);
  const user = await t.makeUser(tenant, []);
  const r = await t.api("put", `/users/${user.id}/roles`, tenant.admin.token).send({ roleIds: [role.body.data.id] });
  if (r.status !== 200) throw new Error(`role assign failed: ${JSON.stringify(r.body)}`);
  return user;
}