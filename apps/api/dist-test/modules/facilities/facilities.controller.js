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
exports.FacilitiesController = void 0;
const common_1 = require("@nestjs/common");
const http_1 = require("../../common/http");
const facilities_service_1 = require("./facilities.service");
let FacilitiesController = class FacilitiesController {
    facilities;
    constructor(facilities) {
        this.facilities = facilities;
    }
    async list(ctx) {
        return { data: await this.facilities.list(ctx) };
    }
    async get(ctx, facilityId) {
        return { data: await this.facilities.get(ctx, (0, http_1.id)(facilityId)) };
    }
    async create(ctx, body) {
        return { data: await this.facilities.create(ctx, (0, http_1.parse)(facilities_service_1.createFacilitySchema, body)) };
    }
    async update(ctx, facilityId, body) {
        return { data: await this.facilities.update(ctx, (0, http_1.id)(facilityId), (0, http_1.parse)(facilities_service_1.updateFacilitySchema, body)) };
    }
};
exports.FacilitiesController = FacilitiesController;
__decorate([
    (0, http_1.AnyAuthenticated)(),
    (0, common_1.Get)(),
    __param(0, (0, http_1.Ctx)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], FacilitiesController.prototype, "list", null);
__decorate([
    (0, http_1.AnyAuthenticated)(),
    (0, common_1.Get)(":id"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], FacilitiesController.prototype, "get", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_SETTINGS"),
    (0, common_1.Post)(),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], FacilitiesController.prototype, "create", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_SETTINGS"),
    (0, common_1.Patch)(":id"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("id")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], FacilitiesController.prototype, "update", null);
exports.FacilitiesController = FacilitiesController = __decorate([
    (0, common_1.Controller)("facilities"),
    __metadata("design:paramtypes", [facilities_service_1.FacilitiesService])
], FacilitiesController);
//# sourceMappingURL=facilities.controller.js.map