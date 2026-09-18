"use client";

import Link from "next/link";

/**
 * Error boundary for the app's pages.
 *
 * Without this file Next.js falls back to its built-in screen ("A server error
 * occurred"), which offers no explanation and no way forward. It matters most for
 * the failures that are *expected* to happen occasionally in production — a
 * serverless database cold start, a connection-limit rejection, a dropped socket —
 * where retrying genuinely is the right move and `reset()` performs it without a
 * full page reload.
 *
 * `error.message` is deliberately NOT rendered. In production Next replaces it with
 * an opaque digest before it reaches the browser, precisely so a stack trace or a
 * connection string can never reach a visitor. The digest is shown instead: it is
 * safe to display and it is the key that matches this render to its server log line.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <section
        aria-labelledby="error-title"
        className="rounded-xl border border-hairline bg-surface p-6"
      >
        <h1 id="error-title" className="text-lg font-semibold text-ink">
          Algo ha fallado al cargar esta página
        </h1>
        <p className="mt-2 text-sm text-ink-secondary">
          El error se ha producido en el servidor. Suele ser temporal — la base de datos puede
          tardar en despertarse tras un periodo de inactividad.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-hairline px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-page"
          >
            Reintentar
          </button>
          <Link
            href="/"
            className="text-sm font-medium text-ink-secondary underline underline-offset-4 hover:text-ink"
          >
            Volver al inicio
          </Link>
        </div>

        {error.digest ? (
          <p className="mt-5 text-xs text-ink-muted">
            Referencia del error:{" "}
            <code className="rounded bg-page px-1 py-0.5">{error.digest}</code>
          </p>
        ) : null}
      </section>
    </main>
  );
}
