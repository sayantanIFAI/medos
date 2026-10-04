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
exports.UsersController = void 0;
const common_1 = require("@nestjs/common");
const http_1 = require("../../common/http");
const users_service_1 = require("./users.service");
let UsersController = class UsersController {
    users;
    constructor(users) {
        this.users = users;
    }
    async list(ctx, query) {
        const q = (0, http_1.parse)(users_service_1.listUsersSchema, query);
        const { items, total } = await this.users.list(ctx, q);
        return (0, http_1.paginate)(items, total, q.page, q.pageSize);
    }
    async create(ctx, body) {
        return { data: await this.users.create(ctx, (0, http_1.parse)(users_service_1.createUserSchema, body)) };
    }
    async changeOwnPassword(ctx, body) {
        await this.users.changeOwnPassword(ctx, (0, http_1.parse)(users_service_1.changePasswordSchema, body));
    }
    async get(ctx, userId) {
        return { data: await this.users.get(ctx, (0, http_1.id)(userId)) };
    }
    async update(ctx, userId, body) {
        return { data: await this.users.update(ctx, (0, http_1.id)(userId), (0, http_1.parse)(users_service_1.updateUserSchema, body)) };
    }
    async setRoles(ctx, userId, body) {
        return { data: await this.users.setRoles(ctx, (0, http_1.id)(userId), (0, http_1.parse)(users_service_1.setRolesSchema, body)) };
    }
    async setFacilities(ctx, userId, body) {
        return { data: await this.users.setFacilities(ctx, (0, http_1.id)(userId), (0, http_1.parse)(users_service_1.setFacilitiesSchema, body)) };
    }
    async resetPassword(ctx, userId, body) {
        await this.users.resetPassword(ctx, (0, http_1.id)(userId), (0, http_1.parse)(users_service_1.resetPasswordSchema, body));
    }
    async roles(ctx) {
        return { data: await this.users.listRoles(ctx) };
    }
    async createRole(ctx, body) {
        return { data: await this.users.createRole(ctx, (0, http_1.parse)(users_service_1.createRoleSchema, body)) };
    }
    async setRolePermissions(ctx, roleId, body) {
        return { data: await this.users.setRolePermissions(ctx, (0, http_1.id)(roleId), (0, http_1.parse)(users_service_1.setPermissionsSchema, body)) };
    }
};
exports.UsersController = UsersController;
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Get)("users"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Query)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "list", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Post)("users"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "create", null);
__decorate([
    (0, http_1.AnyAuthenticated)(),
    (0, http_1.RateLimit)({ limit: 10, windowMs: 60_000 }),
    (0, common_1.Post)("users/me/password"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "changeOwnPassword", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Get)("users/:id"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "get", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Patch)("users/:id"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("id")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "update", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Put)("users/:id/roles"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("id")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "setRoles", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Put)("users/:id/facilities"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("id")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "setFacilities", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Post)("users/:id/reset-password"),
    (0, common_1.HttpCode)(204),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("id")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "resetPassword", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Get)("roles"),
    __param(0, (0, http_1.Ctx)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "roles", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Post)("roles"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "createRole", null);
__decorate([
    (0, http_1.RequirePermissions)("ADMIN_USERS"),
    (0, common_1.Put)("roles/:id/permissions"),
    __param(0, (0, http_1.Ctx)()),
    __param(1, (0, common_1.Param)("id")),
    __param(2, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", Promise)
], UsersController.prototype, "setRolePermissions", null);
exports.UsersController = UsersController = __decorate([
    (0, common_1.Controller)(),
    __metadata("design:paramtypes", [users_service_1.UsersService])
], UsersController);
//# sourceMappingURL=users.controller.js.map