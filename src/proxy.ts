/**
 * Password gate for the whole app (Next.js 16 `proxy` convention — formerly `middleware`).
 *
 * Design rule: DENY BY DEFAULT. The matcher below is deliberately as broad as possible and
 * the function keeps a tiny, exact-match allowlist. Anything not literally equal to an
 * allowlisted path requires a valid session cookie — so a new route added by another team
 * (`/measurements`, `/import-health`, `/api/insights`, anything) is protected the moment it
 * exists, without anyone remembering to update this file.
 *
 * The matcher is treated as a performance filter, never as the security boundary. The
 * security boundary is the `isPublicPath` check inside `proxy()`.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

/**
 * The only paths reachable without a session.
 *
 * Matched with strict string equality against `request.nextUrl.pathname`. Anything that is
 * not byte-identical to one of these — `/login/`, `/Login`, `/%6cogin`, `/login/../api/...`,
 * `//login` — falls through to the protected branch. That is the safe direction: the worst
 * case is a redirect to the login page, never an unintended pass-through.
 */
const PUBLIC_PATHS = new Set<string>(["/login", "/api/auth"]);

/** Paths Next.js serves as build assets. No user data can be reached through them. */
const ASSET_PREFIXES = ["/_next/static/", "/_next/image"];

/**
 * Re-derives a canonical path from the raw pathname so we can spot smuggling attempts.
 *
 * Next.js already normalises `nextUrl.pathname` (percent-decoding, `.`/`..` resolution,
 * duplicate-slash collapse), so this is a second, independent opinion rather than the
 * primary defence. We only use it to *narrow* what counts as public, never to widen it.
 */
function canonicalize(pathname: string): string {
  let path = pathname;
  // Unwrap repeated percent-encoding (%252e -> %2e -> .) before inspecting segments.
  for (let i = 0; i < 3; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  path = path.replace(/\\/g, "/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

/**
 * A path is public only if BOTH the raw pathname and its canonical form are the same
 * allowlisted literal. Requiring agreement means any encoding, casing, traversal or
 * slash trick produces a mismatch and is treated as protected.
 */
function isPublicPath(pathname: string): boolean {
  if (!PUBLIC_PATHS.has(pathname)) return false;
  return canonicalize(pathname) === pathname;
}

function isAssetPath(pathname: string): boolean {
  if (pathname === "/favicon.ico") return true;
  return ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Sanitises the post-login redirect target so `?next=` cannot become an open redirect.
 *
 * Only a same-origin absolute path is accepted. `//evil.com` and `/\evil.com` are rejected
 * because browsers resolve both as protocol-relative URLs pointing off-site.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "/";
  if (raw.length === 0 || raw.length > 512) return "/";
  if (raw[0] !== "/") return "/";
  if (raw[1] === "/" || raw[1] === "\\") return "/";
  // Reject control characters (header/URL smuggling).
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "/";
  }
  return raw;
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/** Responses that depend on the session must never be cached by a CDN or shared proxy. */
function markPrivate<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  return response;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isAssetPath(pathname)) return NextResponse.next();

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authenticated = await verifySessionToken(token);

  if (isPublicPath(pathname)) {
    // Already signed in and asking for the login form: send them to the dashboard.
    if (authenticated && pathname === "/login") {
      const target = safeNextPath(request.nextUrl.searchParams.get("next"));
      return markPrivate(NextResponse.redirect(new URL(target, request.url)));
    }
    return markPrivate(NextResponse.next());
  }

  if (authenticated) return markPrivate(NextResponse.next());

  // --- Unauthenticated, protected path -------------------------------------------------

  if (isApiPath(pathname)) {
    // APIs get a status code, not an HTML redirect, so fetch() callers fail loudly.
    const apiResponse = NextResponse.json({ error: "No autorizado" }, { status: 401 });
    if (token) apiResponse.cookies.delete(SESSION_COOKIE);
    return markPrivate(apiResponse);
  }

  const loginUrl = new URL("/login", request.url);
  const wanted = `${pathname}${search}`;
  if (wanted !== "/") loginUrl.searchParams.set("next", wanted);

  const response = NextResponse.redirect(loginUrl);
  // An expired or forged cookie is cleared so the browser stops re-sending it.
  if (token) response.cookies.delete(SESSION_COOKIE);
  return markPrivate(response);
}

export const config = {
  /**
   * Everything except build assets. Note what is NOT excluded: `/api`. Excluding API routes
   * from the matcher is the single most common way a gate like this is bypassed, because
   * `/api/measurements` and `/api/extract` are exactly the endpoints that read and write
   * the medical data.
   *
   * Server Functions ("use server") are dispatched as POSTs to the page route they live on,
   * so keeping page routes in the matcher keeps them covered too.
   */
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
