"use client";

/**
 * Login form.
 *
 * The password is only ever sent as a JSON POST body to /api/auth. It is never put in a
 * query string, never written to history, and never rendered back into the DOM.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Status = "idle" | "submitting" | "error";

/** Reads `?next=` from the current URL and refuses anything that is not a same-origin path. */
function readSafeNext(): string {
  if (typeof window === "undefined") return "/";
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw || raw.length > 512) return "/";
  if (raw[0] !== "/") return "/";
  if (raw[1] === "/" || raw[1] === "\\") return "/";
  return raw;
}

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  // Tell "wrong password" apart from "this deployment has no password configured", so a
  // locked-out Marc is not left guessing at a password that cannot exist.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth", { method: "GET", cache: "no-store" })
      .then((response) => response.json())
      .then((data: { configured?: boolean; error?: string }) => {
        if (cancelled) return;
        setConfigured(data.configured === true);
        if (data.configured !== true && data.error) setMessage(data.error);
      })
      .catch(() => {
        if (!cancelled) setConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (status === "submitting" || password.length === 0) return;

      setStatus("submitting");
      setMessage(null);

      try {
        const response = await fetch("/api/auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ password }),
        });

        if (response.ok) {
          setPassword("");
          const target = readSafeNext();
          router.replace(target);
          router.refresh();
          return;
        }

        const data: { error?: string } = await response.json().catch(() => ({}));
        setStatus("error");
        setMessage(
          data.error ??
            (response.status === 429
              ? "Demasiados intentos. Inténtalo de nuevo más tarde."
              : "Contraseña incorrecta."),
        );
      } catch {
        setStatus("error");
        setMessage("No se pudo conectar con el servidor.");
      }
    },
    [password, router, status],
  );

  const blocked = configured === false;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-hairline bg-surface p-4 sm:p-5">
          <h1 className="text-lg font-semibold text-ink">Health Overview</h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Introduce la contraseña para acceder a tus datos.
          </p>

          <form onSubmit={onSubmit} className="mt-5 space-y-3" noValidate>
            <div>
              <label htmlFor="password" className="block text-sm text-ink-secondary">
                Contraseña
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                disabled={blocked || status === "submitting"}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (status === "error") setStatus("idle");
                }}
                className="mt-1.5 w-full rounded-lg border border-hairline bg-page px-3 py-2 text-base text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-ink-secondary disabled:opacity-50"
                aria-invalid={status === "error"}
                aria-describedby={message ? "auth-message" : undefined}
              />
            </div>

            <button
              type="submit"
              disabled={blocked || status === "submitting" || password.length === 0}
              className="w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-page transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {status === "submitting" ? "Comprobando…" : "Entrar"}
            </button>
          </form>

          {message ? (
            <p
              id="auth-message"
              role="alert"
              className="mt-3 text-sm"
              style={{ color: "var(--status-critical)" }}
            >
              {message}
            </p>
          ) : null}

          {blocked ? (
            <p className="mt-3 text-xs text-ink-muted">
              Define <code className="font-mono">APP_PASSWORD</code> en las variables de entorno
              del despliegue y vuelve a desplegar. Hasta entonces la aplicación permanece
              bloqueada.
            </p>
          ) : null}
        </div>

        <p className="mt-4 text-center text-xs text-ink-muted">
          Datos personales de salud. No compartas esta contraseña.
        </p>
      </div>
    </main>
  );
}
