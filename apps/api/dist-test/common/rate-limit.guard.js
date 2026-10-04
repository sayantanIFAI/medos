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
exports.RateLimitGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const shared_1 = require("@medos/shared");
const config_1 = require("./config");
const http_1 = require("./http");
/**
 * Fixed-window, in-process limiter keyed by client IP + route. Only active on routes
 * decorated with @RateLimit. In-process state means limits are per API instance (ADR-009);
 * per-account lockout in the auth service is database-backed and instance-independent.
 */
let RateLimitGuard = class RateLimitGuard {
    reflector;
    config;
    buckets = new Map();
    constructor(reflector, config) {
        this.reflector = reflector;
        this.config = config;
    }
    canActivate(ec) {
        const opts = this.reflector.getAllAndOverride(http_1.RATE_LIMIT, [ec.getHandler(), ec.getClass()]);
        if (!opts || !this.config.RATE_LIMIT_ENABLED)
            return true;
        const req = ec.switchToHttp().getRequest();
        const key = `${req.ip ?? "unknown"}|${req.method}|${req.route?.path ?? ""}`;
        const now = Date.now();
        this.sweep(now);
        const b = this.buckets.get(key);
        if (!b || b.resetAt <= now) {
            this.buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
            return true;
        }
        b.count += 1;
        if (b.count > opts.limit)
            throw new shared_1.DomainError("RATE_LIMITED", "Too many requests. Try again later.", 429);
        return true;
    }
    sweep(now) {
        if (this.buckets.size < 5000)
            return;
        for (const [k, b] of this.buckets)
            if (b.resetAt <= now)
                this.buckets.delete(k);
    }
};
exports.RateLimitGuard = RateLimitGuard;
exports.RateLimitGuard = RateLimitGuard = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Inject)(config_1.CONFIG)),
    __metadata("design:paramtypes", [core_1.Reflector, Object])
], RateLimitGuard);
//# sourceMappingURL=rate-limit.guard.js.map