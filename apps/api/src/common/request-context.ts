import type { Permission } from "@medos/shared";

/**
 * Authoritative, server-derived request context. Built by AuthGuard from the verified
 * token plus a fresh database lookup; never from request body/query/headers.
 */
export interface RequestContext {
  readonly tenantId: string;
  readonly facilityId: string;
  readonly userId: string;
  readonly permissions: ReadonlySet<Permission>;
  readonly requestId: string;
}

export interface AuthedRequest {
  ctx?: RequestContext;
  requestId?: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  route?: { path?: string };
  method: string;
}
