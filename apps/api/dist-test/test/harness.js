"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PASSWORD = void 0;
exports.startApp = startApp;
require("reflect-metadata");
const node_crypto_1 = require("node:crypto");
const shared_1 = require("@medos/shared");
const supertest_1 = __importDefault(require("supertest"));
const url = process.env["TEST_DATABASE_URL"] ?? "postgresql://medos@127.0.0.1:54329/medos_test";
if (!new URL(url).pathname.replace("/", "").endsWith("_test")) {
    throw new Error("Refusing to run tests against a database whose name does not end with _test");
}
process.env["NODE_ENV"] = "test";
process.env["DATABASE_URL"] = url;
process.env["JWT_ACCESS_SECRET"] ??= "test-access-secret-0123456789abcdef-test";
process.env["SCRYPT_LOG_N"] ??= "10";
const bootstrap_1 = require("../bootstrap");
const prisma_service_1 = require("../common/prisma.service");
const tenants_service_1 = require("../modules/tenants/tenants.service");
const password_service_1 = require("../modules/auth/password.service");
exports.PASSWORD = "Synthetic-Pass-123";
async function startApp(opts = {}) {
    process.env["RATE_LIMIT_ENABLED"] = opts.rateLimit ? "true" : "false";
    const app = await (0, bootstrap_1.createApp)();
    await app.init();
    const prisma = app.get(prisma_service_1.PrismaService);
    const tenants = app.get(tenants_service_1.TenantsService);
    const passwords = app.get(password_service_1.PasswordService);
    const server = app.getHttpServer();
    const api = (method, path, token) => {
        const r = (0, supertest_1.default)(server)[method](`/api/v1${path}`);
        return token ? r.set("Authorization", `Bearer ${token}`) : r;
    };
    const login = (tenantCode, username, password = exports.PASSWORD, facilityId) => (0, supertest_1.default)(server).post("/api/v1/auth/login").send({ tenantCode, identifier: username, password, ...(facilityId ? { facilityId } : {}) });
    const tokenFor = async (code, username, facilityId) => {
        const r = await login(code, username, exports.PASSWORD, facilityId);
        if (r.status !== 200 || r.body.data.status !== "AUTHENTICATED")
            throw new Error(`test login failed: ${r.status} ${JSON.stringify(r.body)}`);
        return r.body.data.tokens.accessToken;
    };
    const makeTenant = async (label = "t") => {
        const suffix = (0, node_crypto_1.randomBytes)(4).toString("hex");
        const code = `${label}-${suffix}`.toLowerCase();
        const res = await tenants.provision({
            tenant: { name: `Synthetic Hospital ${code}`, code, timezone: "Asia/Kolkata" },
            facility: { name: "Main Campus", code: `MC${suffix.slice(0, 4).toUpperCase()}`, city: "Kolkata", state: "West Bengal" },
            admin: { username: "admin", fullName: "Synthetic Admin", password: exports.PASSWORD },
        });
        const facility2 = await prisma.facility.create({ data: { tenantId: res.tenantId, name: "Annex", code: `AX${suffix.slice(0, 4).toUpperCase()}` } });
        const roles = await prisma.role.findMany({ where: { tenantId: res.tenantId } });
        const roleIds = Object.fromEntries(roles.map((r) => [r.name, r.id]));
        await prisma.userFacility.create({ data: { tenantId: res.tenantId, userId: res.adminUserId, facilityId: facility2.id } });
        const token = await tokenFor(code, "admin", res.facilityId);
        return { tenantId: res.tenantId, code, facilityId: res.facilityId, facility2Id: facility2.id, admin: { id: res.adminUserId, username: "admin", token }, roleIds };
    };
    const makeUser = async (t, roleNames, o = {}) => {
        const username = o.username ?? `u${(0, node_crypto_1.randomBytes)(4).toString("hex")}`;
        const passwordHash = await passwords.hash(exports.PASSWORD);
        const user = await prisma.user.create({ data: { tenantId: t.tenantId, username, fullName: `Synthetic ${username}`, passwordHash } });
        const facilityIds = o.facilityIds ?? [t.facilityId];
        await prisma.userFacility.createMany({ data: facilityIds.map((facilityId) => ({ tenantId: t.tenantId, userId: user.id, facilityId })) });
        for (const n of roleNames) {
            const roleId = t.roleIds[n];
            if (!roleId || !(n in shared_1.SYSTEM_ROLES))
                throw new Error(`unknown system role ${n}`);
            await prisma.userRole.create({ data: { tenantId: t.tenantId, userId: user.id, roleId } });
        }
        const token = await tokenFor(t.code, username, facilityIds[0]);
        return { id: user.id, username, token };
    };
    return {
        app, prisma, api, login, makeTenant, makeUser,
        http: () => (0, supertest_1.default)(server),
        close: async () => { await app.close(); },
    };
}
//# sourceMappingURL=harness.js.map