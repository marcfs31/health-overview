/**
 * Session auth for the Health Overview app.
 *
 * This module is imported by `src/proxy.ts`, so it must stay runtime-agnostic:
 * NO `node:*` imports, no `fs`, no `next/headers` at module scope. Everything here
 * runs on WebCrypto + jose, which work identically in the Node.js and Edge runtimes.
 *
 * Threat model: the app is deployed to a public URL and serves personal medical data
 * (weight, body-fat %, InBody scans). The password gate is the only boundary, so every
 * branch below fails CLOSED — a missing, short or malformed config denies access rather
 * than allowing it.
 */

import { SignJWT, jwtVerify } from "jose";

export const SESSION_COOKIE = "ho_session";

const ISSUER = "health-overview";
const AUDIENCE = "health-overview-app";
const ALG = "HS256";

/** 7 days. Long enough to be usable on a personal app, short enough to bound a stolen cookie. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Minimum AUTH_SECRET length. 32 chars of hex is 128 bits; we ship 64. */
const MIN_SECRET_LENGTH = 32;
/** Minimum APP_PASSWORD length. A public URL holding medical data does not get a 4-char password. */
const MIN_PASSWORD_LENGTH = 8;
/** Upper bound on submitted password length, so a huge body cannot burn CPU in the HMAC. */
const MAX_PASSWORD_INPUT = 1024;

export type AuthConfig = {
  ok: true;
  /** Raw bytes of AUTH_SECRET, used as the HMAC key for the session JWT. */
  secretKey: Uint8Array;
  /** The configured password. Never logged, never serialised, never returned to a client. */
  password: string;
};

export type AuthConfigError = {
  ok: false;
  /** Stable machine code for logging/branching. Never contains secret material. */
  code: "missing_secret" | "weak_secret" | "missing_password" | "weak_password";
  /** Operator-facing Spanish message. Safe to show: it describes config state, not secrets. */
  message: string;
};

/**
 * Reads and validates the auth configuration.
 *
 * Returns an error result — never throws, never falls back to a default — when either
 * env var is missing or too weak. Callers MUST treat any `ok: false` as "deny everything".
 */
export function getAuthConfig(): AuthConfig | AuthConfigError {
  const secret = process.env.AUTH_SECRET;
  const password = process.env.APP_PASSWORD;

  if (typeof secret !== "string" || secret.length === 0) {
    return {
      ok: false,
      code: "missing_secret",
      message: "Falta AUTH_SECRET. Define la variable de entorno antes de usar la aplicación.",
    };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      ok: false,
      code: "weak_secret",
      message: `AUTH_SECRET es demasiado corto (mínimo ${MIN_SECRET_LENGTH} caracteres).`,
    };
  }
  // Empty string, whitespace-only and unset all land here. This is the classic fail-open
  // spot: an empty APP_PASSWORD must never mean "any password works" or "no password needed".
  if (typeof password !== "string" || password.trim().length === 0) {
    return {
      ok: false,
      code: "missing_password",
      message: "Falta APP_PASSWORD. La aplicación permanece bloqueada hasta que se defina.",
    };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      code: "weak_password",
      message: `APP_PASSWORD es demasiado corto (mínimo ${MIN_PASSWORD_LENGTH} caracteres).`,
    };
  }

  return { ok: true, secretKey: new TextEncoder().encode(secret), password };
}

/* -------------------------------------------------------------------------- */
/* Constant-time primitives                                                    */
/* -------------------------------------------------------------------------- */

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Copy into a fresh, offset-0 buffer so WebCrypto never sees a view into a larger pool.
  return bytes.slice().buffer as ArrayBuffer;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(data));
  return new Uint8Array(sig);
}

/** Constant-time compare of two equal-length byte arrays. */
function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Compares two secrets in constant time **regardless of their lengths**.
 *
 * `crypto.timingSafeEqual` throws on a length mismatch, which by itself leaks the length of
 * the real password. The double-HMAC construction below hashes both sides under a freshly
 * generated random key, so the comparison always runs over 32 equal bytes and the attacker
 * cannot predict or replay the intermediate digests.
 */
export async function constantTimeEquals(candidate: string, expected: string): Promise<boolean> {
  const blindKey = crypto.getRandomValues(new Uint8Array(32));
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    hmacSha256(blindKey, enc.encode(candidate)),
    hmacSha256(blindKey, enc.encode(expected)),
  ]);
  return timingSafeEqualBytes(a, b);
}

/* -------------------------------------------------------------------------- */
/* Password verification                                                       */
/* -------------------------------------------------------------------------- */

export type PasswordResult =
  | { ok: true }
  | { ok: false; reason: "not_configured"; message: string }
  | { ok: false; reason: "invalid" };

/**
 * Verifies a submitted password against APP_PASSWORD.
 *
 * Fails closed on every non-happy path. There is deliberately no branch that can return
 * `ok: true` when the config is invalid or the candidate is empty.
 */
export async function verifyPassword(candidate: unknown): Promise<PasswordResult> {
  const config = getAuthConfig();
  if (!config.ok) return { ok: false, reason: "not_configured", message: config.message };

  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > MAX_PASSWORD_INPUT) {
    // Still burn a comparison so a rejected-early input is not measurably faster.
    await constantTimeEquals("", config.password);
    return { ok: false, reason: "invalid" };
  }

  const match = await constantTimeEquals(candidate, config.password);
  return match ? { ok: true } : { ok: false, reason: "invalid" };
}

/* -------------------------------------------------------------------------- */
/* Session token                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A short fingerprint of the current password, embedded in the token as `pv`.
 *
 * Rotating APP_PASSWORD changes this value, which invalidates every session issued under
 * the old password. Without it, a cookie minted before a password change would stay valid
 * for its full 7 days — i.e. rotating the password after a suspected leak would do nothing.
 */
async function passwordFingerprint(config: AuthConfig): Promise<string> {
  const digest = await hmacSha256(config.secretKey, new TextEncoder().encode(`pv:${config.password}`));
  let out = "";
  for (let i = 0; i < 16; i++) out += digest[i].toString(16).padStart(2, "0");
  return out;
}

/** Mints a signed session token. Returns null when the config is invalid (fail closed). */
export async function createSessionToken(): Promise<string | null> {
  const config = getAuthConfig();
  if (!config.ok) return null;

  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ pv: await passwordFingerprint(config) })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setSubject("marc")
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + SESSION_MAX_AGE_SECONDS)
    .sign(config.secretKey);
}

/**
 * Verifies a session token: signature, pinned algorithm, issuer, audience, expiry and
 * password fingerprint. Any failure — including a malformed token or an unusable config —
 * returns false.
 */
export async function verifySessionToken(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return false;

  const config = getAuthConfig();
  if (!config.ok) return false;

  try {
    const { payload } = await jwtVerify(token, config.secretKey, {
      // Pinning the algorithm list is what rejects `alg: none` and HS/RS confusion tokens.
      algorithms: [ALG],
      issuer: ISSUER,
      audience: AUDIENCE,
      clockTolerance: 5,
      requiredClaims: ["exp", "iat", "iss", "aud", "sub"],
    });

    if (payload.sub !== "marc") return false;

    const pv = payload.pv;
    if (typeof pv !== "string") return false;
    return await constantTimeEquals(pv, await passwordFingerprint(config));
  } catch {
    // Signature failure, expiry, malformed JWT, wrong alg — all deny.
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Cookie                                                                      */
/* -------------------------------------------------------------------------- */

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
};

/**
 * Cookie flags for the session.
 *
 * - httpOnly  : document.cookie cannot read it, so an XSS bug cannot exfiltrate the session.
 * - sameSite  : "lax" blocks the cookie on cross-site POSTs (CSRF) while still surviving a
 *               normal top-level navigation from a bookmark or a link.
 * - secure    : always on in production so the cookie never rides a plaintext request.
 *               Left off in dev because http://localhost has no TLS.
 * - path "/"  : the gate covers the whole app.
 */
export function sessionCookieOptions(): SessionCookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function clearedSessionCookieOptions(): SessionCookieOptions & { maxAge: 0 } {
  return { ...sessionCookieOptions(), maxAge: 0 };
}

/* -------------------------------------------------------------------------- */
/* Defence in depth for other routes                                           */
/* -------------------------------------------------------------------------- */

/**
 * Extracts the session cookie from a raw `Cookie` header.
 *
 * Deliberately hand-rolled rather than using `next/headers`: this module is imported by
 * `src/proxy.ts`, and pulling `next/headers` into the proxy bundle risks a build or runtime
 * failure that would take the entire gate offline in production.
 */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Verifies the session directly from an incoming `Request`. Works in a Route Handler, a
 * Server Component (via `headers()`), or anywhere else a Request is in scope.
 *
 * DEFENCE IN DEPTH — please use this. `src/proxy.ts` is the primary gate, but the Next.js
 * docs are explicit that proxy alone is not an authorization solution: a matcher change, a
 * route move, or a Server Function dispatched as a POST to an excluded path can silently
 * drop proxy coverage. Any handler that reads or writes measurement data should open with:
 *
 *     import { verifySessionFromRequest } from "@/lib/auth";
 *
 *     export async function GET(request: Request) {
 *       if (!(await verifySessionFromRequest(request))) {
 *         return Response.json({ error: "No autorizado" }, { status: 401 });
 *       }
 *       ...
 *     }
 */
export async function verifySessionFromRequest(request: Request): Promise<boolean> {
  return verifySessionToken(readSessionCookie(request.headers.get("cookie")));
}
