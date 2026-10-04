import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import { DomainError, type Permission } from "@medos/shared";
import { ZodError, ZodTypeAny, z } from "zod";
import type { AuthedRequest, RequestContext } from "./request-context";

export const IS_PUBLIC = "isPublic";
export const REQUIRED_PERMISSIONS = "requiredPermissions";
export const RATE_LIMIT = "rateLimit";
export const ANY_AUTHENTICATED = "anyAuthenticated";

/** Route needs no authentication (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Caller must hold ALL listed permissions. Routes without this still require authentication. */
export const RequirePermissions = (...p: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, p);
/** Explicitly marks a route as needing authentication only (no specific permission). Audited by a test. */
export const AnyAuthenticated = () => SetMetadata(ANY_AUTHENTICATED, true);
export interface RateLimitOptions { limit: number; windowMs: number }
export const RateLimit = (o: RateLimitOptions) => SetMetadata(RATE_LIMIT, o);

export const Ctx = createParamDecorator((_d: unknown, ec: ExecutionContext): RequestContext => {
  const req = ec.switchToHttp().getRequest<AuthedRequest>();
  if (!req.ctx) throw new DomainError("UNAUTHENTICATED", "Authentication required", 401);
  return req.ctx;
});

export const ClientIp = createParamDecorator((_d: unknown, ec: ExecutionContext): string => {
  return ec.switchToHttp().getRequest<AuthedRequest>().ip ?? "unknown";
});

export const RequestId = createParamDecorator((_d: unknown, ec: ExecutionContext): string | undefined => {
  return ec.switchToHttp().getRequest<AuthedRequest>().requestId;
});

/** Validate external input with a strict zod schema; throws a domain error with field paths only. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function validationError(e: ZodError): DomainError {
  const err = new DomainError("VALIDATION_FAILED", "Request validation failed", 400);
  (err as DomainError & { details?: unknown }).details = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return err;
}

const uuid = z.string().uuid();
/** Path ids that are not UUIDs get the same 404 as unknown ids (no oracle). */
export function id(raw: string): string {
  const r = uuid.safeParse(raw);
  if (!r.success) throw new DomainError("NOT_FOUND", "Resource not found", 404);
  return r.data;
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function paginate<T>(items: T[], total: number, page: number, pageSize: number) {
  return { data: items, meta: { page, pageSize, total } };
}
