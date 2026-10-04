"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = exports.CONTROLLERS = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const audit_service_1 = require("./common/audit.service");
const auth_guard_1 = require("./common/auth.guard");
const config_1 = require("./common/config");
const http_pipeline_1 = require("./common/http-pipeline");
const prisma_service_1 = require("./common/prisma.service");
const rate_limit_guard_1 = require("./common/rate-limit.guard");
const audit_controller_1 = require("./modules/audit/audit.controller");
const auth_controller_1 = require("./modules/auth/auth.controller");
const auth_service_1 = require("./modules/auth/auth.service");
const password_service_1 = require("./modules/auth/password.service");
const facilities_controller_1 = require("./modules/facilities/facilities.controller");
const facilities_service_1 = require("./modules/facilities/facilities.service");
const health_controller_1 = require("./modules/health/health.controller");
const numbering_controller_1 = require("./modules/numbering/numbering.controller");
const numbering_service_1 = require("./modules/numbering/numbering.service");
const tenants_controller_1 = require("./modules/tenants/tenants.controller");
const tenants_service_1 = require("./modules/tenants/tenants.service");
const users_controller_1 = require("./modules/users/users.controller");
const users_service_1 = require("./modules/users/users.service");
/** Single registry so a test can prove every route declares its access policy. */
exports.CONTROLLERS = [
    health_controller_1.HealthController, auth_controller_1.AuthController, tenants_controller_1.TenantsController, facilities_controller_1.FacilitiesController,
    users_controller_1.UsersController, numbering_controller_1.NumberingController, audit_controller_1.AuditController,
];
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        controllers: exports.CONTROLLERS,
        providers: [
            { provide: config_1.CONFIG, useFactory: () => (0, config_1.loadConfig)() },
            prisma_service_1.PrismaService, audit_service_1.AuditService, password_service_1.PasswordService,
            auth_service_1.AuthService, tenants_service_1.TenantsService, facilities_service_1.FacilitiesService, users_service_1.UsersService, numbering_service_1.NumberingService,
            // Order matters: rate limit first (cheap), then authentication + authorization.
            { provide: core_1.APP_GUARD, useClass: rate_limit_guard_1.RateLimitGuard },
            { provide: core_1.APP_GUARD, useClass: auth_guard_1.AuthGuard },
            { provide: core_1.APP_FILTER, useClass: http_pipeline_1.AllExceptionsFilter },
        ],
        exports: [prisma_service_1.PrismaService, numbering_service_1.NumberingService, audit_service_1.AuditService, password_service_1.PasswordService, tenants_service_1.TenantsService],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map