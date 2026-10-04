import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DomainError } from "@medos/shared";
import { CONFIG, type AppConfig } from "./config";
import { RATE_LIMIT, type RateLimitOptions } from "./http";
import type { AuthedRequest } from "./request-context";

interface Bucket { count: number; resetAt: number }

/**
 * Fixed-window, in-process limiter keyed by client IP + route. Only active on routes
 * decorated with @RateLimit. In-process state means limits are per API instance (ADR-009);
 * per-account lockout in the auth service is database-backed and instance-independent.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(ec: ExecutionContext): boolean {
    const opts = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT, [ec.getHandler(), ec.getClass()]);
    if (!opts || !this.config.RATE_LIMIT_ENABLED) return true;
    const req = ec.switchToHttp().getRequest<AuthedRequest>();
    const key = `${req.ip ?? "unknown"}|${req.method}|${req.route?.path ?? ""}`;
    const now = Date.now();
    this.sweep(now);
    const b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      return true;
    }
    b.count += 1;
    if (b.count > opts.limit) throw new DomainError("RATE_LIMITED", "Too many requests. Try again later.", 429);
    return true;
  }

  private sweep(now: number): void {
    if (this.buckets.size < 5000) return;
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }
}
