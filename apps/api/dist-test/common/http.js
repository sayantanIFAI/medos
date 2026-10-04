"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paginationSchema = exports.RequestId = exports.ClientIp = exports.Ctx = exports.RateLimit = exports.AnyAuthenticated = exports.RequirePermissions = exports.Public = exports.ANY_AUTHENTICATED = exports.RATE_LIMIT = exports.REQUIRED_PERMISSIONS = exports.IS_PUBLIC = void 0;
exports.parse = parse;
exports.validationError = validationError;
exports.id = id;
exports.paginate = paginate;
const common_1 = require("@nestjs/common");
const shared_1 = require("@medos/shared");
const zod_1 = require("zod");
exports.IS_PUBLIC = "isPublic";
exports.REQUIRED_PERMISSIONS = "requiredPermissions";
exports.RATE_LIMIT = "rateLimit";
exports.ANY_AUTHENTICATED = "anyAuthenticated";
/** Route needs no authentication (login, health). */
const Public = () => (0, common_1.SetMetadata)(exports.IS_PUBLIC, true);
exports.Public = Public;
/** Caller must hold ALL listed permissions. Routes without this still require authentication. */
const RequirePermissions = (...p) => (0, common_1.SetMetadata)(exports.REQUIRED_PERMISSIONS, p);
exports.RequirePermissions = RequirePermissions;
/** Explicitly marks a route as needing authentication only (no specific permission). Audited by a test. */
const AnyAuthenticated = () => (0, common_1.SetMetadata)(exports.ANY_AUTHENTICATED, true);
exports.AnyAuthenticated = AnyAuthenticated;
const RateLimit = (o) => (0, common_1.SetMetadata)(exports.RATE_LIMIT, o);
exports.RateLimit = RateLimit;
exports.Ctx = (0, common_1.createParamDecorator)((_d, ec) => {
    const req = ec.switchToHttp().getRequest();
    if (!req.ctx)
        throw new shared_1.DomainError("UNAUTHENTICATED", "Authentication required", 401);
    return req.ctx;
});
exports.ClientIp = (0, common_1.createParamDecorator)((_d, ec) => {
    return ec.switchToHttp().getRequest().ip ?? "unknown";
});
exports.RequestId = (0, common_1.createParamDecorator)((_d, ec) => {
    return ec.switchToHttp().getRequest().requestId;
});
/** Validate external input with a strict zod schema; throws a domain error with field paths only. */
function parse(schema, input) {
    const r = schema.safeParse(input);
    if (!r.success)
        throw validationError(r.error);
    return r.data;
}
function validationError(e) {
    const err = new shared_1.DomainError("VALIDATION_FAILED", "Request validation failed", 400);
    err.details = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return err;
}
const uuid = zod_1.z.string().uuid();
/** Path ids that are not UUIDs get the same 404 as unknown ids (no oracle). */
function id(raw) {
    const r = uuid.safeParse(raw);
    if (!r.success)
        throw new shared_1.DomainError("NOT_FOUND", "Resource not found", 404);
    return r.data;
}
exports.paginationSchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().min(1).default(1),
    pageSize: zod_1.z.coerce.number().int().min(1).max(100).default(25),
});
function paginate(items, total, page, pageSize) {
    return { data: items, meta: { page, pageSize, total } };
}
//# sourceMappingURL=http.js.map