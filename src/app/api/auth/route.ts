/**
 * Login / logout endpoint.
 *
 * This route is deliberately reachable without a session (it is on the proxy allowlist) —
 * it is the only door in. Everything it returns is therefore written on the assumption that
 * an attacker is reading it: no password is ever echoed, logged, reflected in an error, or
 * placed in a URL, and the failure message is identical for every wrong password.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  SESSION_COOKIE,
  clearedSessionCookieOptions,
  createSessionToken,
  getAuthConfig,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";

export const runtime = "nodejs";
// Never prerender or cache a login response.
export const dynamic = "force-dynamic";

const BodySchema = z.object({
  // Bounded so a multi-megabyte body cannot be used to burn CPU.
  password: z.string().min(1).max(1024),
});

/* -------------------------------------------------------------------------- */
/* Throttling                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Per-IP attempt throttle.
 *
 * HONEST LIMITATION: this Map lives in the memory of a single serverless instance. On Vercel
 * the app may run several instances concurrently and each one is cold-started with an empty
 * Map, so an attacker who spreads requests across instances (or simply waits out a cold
 * start) gets more attempts than the numbers below suggest. It raises the cost of a naive
 * brute force; it is NOT a substitute for a high-entropy APP_PASSWORD, and it is not a
 * durable rate limiter. A real one needs shared state (Upstash/Redis) or Vercel Firewall.
 */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
/** Floor on response time, applied to success and failure alike so it is not an oracle. */
const MIN_RESPONSE_MS = 300;

type AttemptRecord = { count: number; firstAttemptAt: number; lockedUntil: number };
const attempts = new Map<string, AttemptRecord>();

function pruneAttempts(now: number): void {
  if (attempts.size < 1000) return;
  for (const [key, record] of attempts) {
    if (record.lockedUntil < now && now - record.firstAttemptAt > WINDOW_MS) attempts.delete(key);
  }
}

/**
 * Best-effort client identity.
 *
 * On Vercel, `x-forwarded-for` is set by the platform edge and cannot be spoofed by the
 * client. Running anywhere without a trusted proxy in front, this header IS attacker
 * controlled and the throttle degrades to "no throttle".
 */
function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 64);
  return request.headers.get("x-real-ip")?.slice(0, 64) ?? "unknown";
}

function checkThrottle(key: string, now: number): { allowed: boolean; retryAfter: number } {
  const record = attempts.get(key);
  if (!record) return { allowed: true, retryAfter: 0 };
  if (record.lockedUntil > now) {
    return { allowed: false, retryAfter: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  if (now - record.firstAttemptAt > WINDOW_MS) {
    attempts.delete(key);
    return { allowed: true, retryAfter: 0 };
  }
  return { allowed: true, retryAfter: 0 };
}

function recordFailure(key: string, now: number): void {
  const record = attempts.get(key);
  if (!record || now - record.firstAttemptAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAttemptAt: now, lockedUntil: 0 });
    return;
  }
  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
    record.count = 0;
    record.firstAttemptAt = now;
  }
}

async function padTo(startedAt: number): Promise<void> {
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_RESPONSE_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_RESPONSE_MS - elapsed));
  }
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store, max-age=0, must-revalidate");
  return response;
}

/* -------------------------------------------------------------------------- */
/* POST /api/auth — sign in                                                    */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request) {
  const startedAt = Date.now();
  const now = startedAt;

  // Requiring a JSON content type means a cross-origin HTML form cannot post here without
  // a CORS preflight, which we never answer. Combined with SameSite=Lax on the cookie this
  // closes the login-CSRF path.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    await padTo(startedAt);
    return noStore(NextResponse.json({ error: "Solicitud inválida." }, { status: 415 }));
  }

  // Fail closed BEFORE touching any credential path when the deployment is misconfigured.
  const config = getAuthConfig();
  if (!config.ok) {
    await padTo(startedAt);
    return noStore(
      NextResponse.json(
        {
          error: config.message,
          code: config.code,
          configured: false,
        },
        { status: 503 },
      ),
    );
  }

  const key = clientKey(request);
  pruneAttempts(now);
  const throttle = checkThrottle(key, now);
  if (!throttle.allowed) {
    await padTo(startedAt);
    const response = NextResponse.json(
      { error: "Demasiados intentos. Inténtalo de nuevo más tarde." },
      { status: 429 },
    );
    response.headers.set("Retry-After", String(throttle.retryAfter));
    return noStore(response);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    recordFailure(key, now);
    await padTo(startedAt);
    return noStore(NextResponse.json({ error: "Solicitud inválida." }, { status: 400 }));
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    // NOTE: zod issues are intentionally NOT returned here. They would echo the submitted
    // value back to the caller, which for this endpoint is the password itself.
    recordFailure(key, now);
    await padTo(startedAt);
    return noStore(NextResponse.json({ error: "Contraseña incorrecta." }, { status: 401 }));
  }

  const result = await verifyPassword(parsed.data.password);

  if (!result.ok) {
    if (result.reason === "not_configured") {
      await padTo(startedAt);
      return noStore(
        NextResponse.json({ error: result.message, configured: false }, { status: 503 }),
      );
    }
    recordFailure(key, now);
    await padTo(startedAt);
    return noStore(NextResponse.json({ error: "Contraseña incorrecta." }, { status: 401 }));
  }

  const token = await createSessionToken();
  if (!token) {
    // Unreachable while the config is valid, but never fall through to a success response.
    await padTo(startedAt);
    return noStore(
      NextResponse.json({ error: "No se pudo iniciar la sesión.", configured: false }, { status: 503 }),
    );
  }

  attempts.delete(key);
  await padTo(startedAt);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return noStore(response);
}

/* -------------------------------------------------------------------------- */
/* DELETE /api/auth — sign out                                                 */
/* -------------------------------------------------------------------------- */

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", clearedSessionCookieOptions());
  return noStore(response);
}

/**
 * Probed by the login page to tell "wrong password" apart from "this deployment has no
 * password set". Returns only a boolean about configuration state — never the password,
 * its length, or the secret.
 */
export async function GET() {
  const config = getAuthConfig();
  return noStore(
    NextResponse.json(
      config.ok ? { configured: true } : { configured: false, error: config.message },
    ),
  );
}
