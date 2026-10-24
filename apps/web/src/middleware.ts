import { NextResponse, type NextRequest } from "next/server";

/** UX redirect only: the API enforces authentication and permissions on every call. */
export function middleware(req: NextRequest) {
  const has = req.cookies.has("medos_at") || req.cookies.has("medos_rt");
  const { pathname } = req.nextUrl;
  if (!has && pathname !== "/login") return NextResponse.redirect(new URL("/login", req.url));
  if (has && pathname === "/login") return NextResponse.redirect(new URL("/dashboard", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!api|_next|favicon.ico).*)"] };
