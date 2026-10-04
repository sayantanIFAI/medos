"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AllExceptionsFilter = void 0;
exports.requestLogMiddleware = requestLogMiddleware;
const common_1 = require("@nestjs/common");
const shared_1 = require("@medos/shared");
const database_1 = require("@medos/database");
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const logger_1 = require("./logger");
const http_1 = require("./http");
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
/**
 * Assigns a request id (accepting a well-formed inbound one) and logs one structured line per request.
 * Registered with app.use() BEFORE body parsing so even body-parser failures carry a request id.
 */
function requestLogMiddleware(req, res, next) {
    {
        const inbound = req.headers["x-request-id"];
        const requestId = typeof inbound === "string" && SAFE_REQUEST_ID.test(inbound) ? inbound : (0, node_crypto_1.randomUUID)();
        req.requestId = requestId;
        res.setHeader("x-request-id", requestId);
        const started = process.hrtime.bigint();
        res.on("finish", () => {
            const r = req;
            const ms = Number((process.hrtime.bigint() - started) / 1000000n);
            (0, logger_1.logJson)("info", "http_request", {
                requestId,
                tenantId: r.ctx?.tenantId,
                facilityId: r.ctx?.facilityId,
                userId: r.ctx?.userId,
                method: req.method,
                route: req.route?.path ?? "unmatched",
                status: res.statusCode,
                errorCode: r.errorCode,
                ms,
            });
        });
        next();
    }
}
/** body-parser (express) errors carry a numeric status and a type like entity.too.large. */
function isBodyParserError(e) {
    return typeof e === "object" && e !== null && typeof e.status === "number"
        && typeof e.type === "string" && e.type.startsWith("entity.");
}
/** Central mapping of every failure to the stable error envelope; never leaks internals. */
let AllExceptionsFilter = class AllExceptionsFilter {
    catch(exception, host) {
        const http = host.switchToHttp();
        const req = http.getRequest();
        const res = http.getResponse();
        const requestId = req.requestId;
        let status = 500;
        let body = { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId } };
        if (exception instanceof shared_1.DomainError) {
            status = exception.httpStatus;
            body = { error: { code: exception.code, message: exception.message, details: exception.details, requestId } };
        }
        else if (exception instanceof zod_1.ZodError) {
            const e = (0, http_1.validationError)(exception);
            status = 400;
            body = { error: { code: e.code, message: e.message, details: e.details, requestId } };
        }
        else if (exception instanceof common_1.HttpException) {
            status = exception.getStatus();
            const map = {
                400: ["VALIDATION_FAILED", "Malformed request"],
                401: ["UNAUTHENTICATED", "Authentication required"],
                403: ["FORBIDDEN", "You do not have permission to perform this action"],
                404: ["NOT_FOUND", "Resource not found"],
                413: ["VALIDATION_FAILED", "Request body too large"],
                415: ["VALIDATION_FAILED", "Unsupported content type"],
                429: ["RATE_LIMITED", "Too many requests. Try again later."],
            };
            const [code, message] = map[status] ?? ["INTERNAL_ERROR", "An unexpected error occurred"];
            body = { error: { code, message, requestId } };
        }
        else if (isBodyParserError(exception)) {
            status = exception.status === 413 ? 413 : 400;
            body = status === 413
                ? { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large", requestId } }
                : { error: { code: "VALIDATION_FAILED", message: "Malformed request body", requestId } };
        }
        else if (exception instanceof database_1.Prisma.PrismaClientKnownRequestError) {
            if (exception.code === "P2002") {
                status = 409;
                body = { error: { code: "CONFLICT", message: "A record with these values already exists", requestId } };
            }
            else if (exception.code === "P2025") {
                status = 404;
                body = { error: { code: "NOT_FOUND", message: "Resource not found", requestId } };
            }
        }
        if (status >= 500) {
            (0, logger_1.logJson)("error", "unhandled_exception", {
                requestId,
                errorName: exception instanceof Error ? exception.name : typeof exception,
                // message may contain SQL; it is logged server-side only and never returned.
                errorMessage: exception instanceof Error ? exception.message.slice(0, 500) : undefined,
            });
        }
        req.errorCode = body.error.code;
        res.status(status).json(body);
    }
};
exports.AllExceptionsFilter = AllExceptionsFilter;
exports.AllExceptionsFilter = AllExceptionsFilter = __decorate([
    (0, common_1.Catch)()
], AllExceptionsFilter);
//# sourceMappingURL=http-pipeline.js.map