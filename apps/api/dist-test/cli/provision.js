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
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const core_1 = require("@nestjs/core");
const app_module_1 = require("../app.module");
const tenants_service_1 = require("../modules/tenants/tenants.service");
/**
 * Platform-operator CLI: provisions a tenant, first facility and administrator.
 * Input is a JSON file path (argv[2]) so the admin password never appears in the process list/shell history.
 *   node dist/cli/provision.js ./tenant.json
 */
async function run() {
    const path = process.argv[2];
    if (!path)
        throw new Error("Usage: provision <config.json>");
    const { readFileSync } = await Promise.resolve().then(() => __importStar(require("node:fs")));
    const input = tenants_service_1.provisionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const app = await core_1.NestFactory.createApplicationContext(app_module_1.AppModule, { logger: ["error"] });
    try {
        const result = await app.get(tenants_service_1.TenantsService).provision(input);
        process.stdout.write(`Provisioned tenant ${result.tenantId} facility ${result.facilityId} admin ${result.adminUserId}\n`);
    }
    finally {
        await app.close();
    }
}
run().catch((e) => {
    process.stderr.write(`Provision failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
//# sourceMappingURL=provision.js.map