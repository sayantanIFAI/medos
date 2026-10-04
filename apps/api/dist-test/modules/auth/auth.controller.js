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
exports.AuthController = void 0;
const common_1 = require("@nestjs/common");
const http_1 = require("../../common/http");
const auth_service_1 = require("./auth.service");
let AuthController = class AuthController {
    auth;
    constructor(auth) {
        this.auth = auth;
    }
    async login(body, requestId, _ip) {
        return { data: await this.auth.login((0, http_1.parse)(auth_service_1.loginSchema, body), requestId) };
    }
    async refresh(body, requestId) {
        return { data: await this.auth.refresh((0, http_1.parse)(auth_service_1.refreshSchema, body).refreshToken, requestId) };
    }
    async logout(body, requestId) {
        await this.auth.logout((0, http_1.parse)(auth_service_1.refreshSchema, body).refreshToken, requestId);
    }
    async switchFacility(ctx, body, requestId) {
        return { data: await this.auth.switchFacility(ctx.userId, ctx.tenantId, (0, http_1.parse)(auth_service_1.switchFacilitySchema, body), requestId) };
    }
    async me(ctx) {
        return { data: await this.auth.me(ctx.tenantId, ctx.userId, ctx.facilityId, ctx.permissions) };
    }
};
exports.AuthController = AuthController;
__decorate([
    (0, http_1.Public)(),
    (0, http_1.RateLimit)({ limit: 10, windowMs: 60_000 }),
    (0, common_1.Post)("login"),
    (0, common_1.HttpCode)(200),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, http_1.RequestId)()),
    __param(2, (0, http_1.ClientIp)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "login", null);
__decorate([
    (0, http_1.Public)(),
    (0, http_1.RateLimit)({ limit: 30, windowMs: 60_000 }),
    (0, common_1.Post)("refresh"),
    (0, common_1.HttpCode)(200),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, http_1.RequestId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "refresh", null);
__decorate([
    (0, http_1.Public)(),
    (0, http_1.RateLimit)({ limit: 30, windowMs: 60_000 }),
    (0, common_1.Post)("logout"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, http_1.RequestId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "logout", null);
__decorate([
    (0, http_1.AnyAuthenticated)(),
    (0, http_1.RateLimit)({ limit: 30, windowMs: 60_000 }),
    (0, common_1.Post)("switch-facility"),
    (0, common_1.HttpCode)(200),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, http_1.RequestId)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "switchFacility", null);
__decorate([
    (0, http_1.AnyAuthenticated)(),
    (0, common_1.Get)("me"),
    __param(0, (0, http_1.Ctx)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], AuthController.prototype, "me", null);
exports.AuthController = AuthController = __decorate([
    (0, common_1.Controller)("auth"),
    __metadata("design:paramtypes", [auth_service_1.AuthService])
], AuthController);
//# sourceMappingURL=auth.controller.js.map