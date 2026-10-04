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
exports.NumberingController = void 0;
const common_1 = require("@nestjs/common");
const http_1 = require("../../common/http");
const numbering_service_1 = require("./numbering.service");
const shared_1 = require("@medos/shared");
let NumberingController = class NumberingController {
    numbering;
    constructor(numbering) {
        this.numbering = numbering;
    }
    async list(ctx) {
        return { data: await this.numbering.list(ctx) };
    }
    async update(ctx, type, body) {
        const t = numbering_service_1.sequenceTypeSchema.safeParse(type);
        if (!t.success)
            throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
        return { data: await this.numbering.update(ctx, t.data, (0, http_1.parse)(numbering_service_1.sequenceConfigSchema, body)) };
    }
};
exports.NumberingController = NumberingController;
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_SETTINGS"),
    (0, common_1.Get)(),
    __param(0, (0, http_1.Ctx)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], NumberingController.prototype, "list", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_SETTINGS"),
    (0, common_1.Put)(":type"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("type")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], NumberingController.prototype, "update", null);
exports.NumberingController = NumberingController = __decorate([
    (0, common_1.Controller)("number-sequences"),
    __metadata("design:paramtypes", [numbering_service_1.NumberingService])
], NumberingController);
//# sourceMappingURL=numbering.controller.js.map