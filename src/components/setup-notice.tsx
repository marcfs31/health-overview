/**
 * Shown by the data pages when no database is configured.
 *
 * This is a *deployment* state, not a user error and not a crash: the app is
 * healthy, the password gate works, there is simply nowhere to read measurements
 * from yet. It names the exact variable and the exact command, because the only
 * person who ever sees this screen is the one who can fix it.
 */
export function SetupNotice() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <section
        aria-labelledby="setup-title"
        className="rounded-xl border border-hairline bg-surface p-6"
        style={{ borderColor: "var(--status-warning)" }}
      >
        <h1 id="setup-title" className="text-lg font-semibold text-ink">
          Falta configurar la base de datos
        </h1>
        <p className="mt-2 text-sm text-ink-secondary">
          La aplicación funciona y tu sesión es válida, pero este despliegue no tiene ninguna
          base de datos conectada, así que todavía no hay ningún sitio de donde leer tus
          mediciones.
        </p>
        <p className="mt-4 text-sm text-ink-secondary">
          Define la variable de entorno{" "}
          <code className="rounded bg-page px-1 py-0.5 text-xs">DATABASE_URL</code> en el proyecto
          y vuelve a desplegar. Para aprovisionar una base de datos Postgres desde cero:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-page p-3 text-xs text-ink">
          <code>vercel integration add neon</code>
        </pre>
        <p className="mt-4 text-xs text-ink-muted">
          Las variables de entorno se aplican en el despliegue, no en caliente: después de
          añadirla hay que volver a desplegar para que el cambio tenga efecto.
        </p>
      </section>
    </main>
  );
}
