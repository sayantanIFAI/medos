"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenantsController = void 0;
const common_1 = require("@nestjs/common");
const http_1 = require("../../common/http");
const tenants_service_1 = require("./tenants.service");
let TenantsController = class TenantsController {
    tenants;
    constructor(tenants) {
        this.tenants = tenants;
    }
    async current(ctx) {
        return { data: await this.tenants.getCurrent(ctx) };
    }
    async update(ctx, body) {
        return { data: await this.tenants.updateCurrent(ctx, (0, http_1.parse)(tenants_service_1.updateTenantSchema, body)) };
    }
};
exports.TenantsController = TenantsController;
__decorate([
    (0, http_1.AnyAuthenticated)(),
    (0, common_1.Get)("current"),
    __param(0, (0, http_1.Ctx)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], TenantsController.prototype, "current", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_SETTINGS"),
    (0, common_1.Patch)("current"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], TenantsController.prototype, "update", null);
exports.TenantsController = TenantsController = __decorate([
    (0, common_1.Controller)("tenants"),
    __metadata("design:paramtypes", [tenants_service_1.TenantsService])
], TenantsController);
//# sourceMappingURL=tenants.controller.js.map