import { Fragment } from "react";
import { desc } from "drizzle-orm";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db, isDatabaseConfigured, measurements, type Measurement } from "@/lib/db";
import { SegmentalView } from "@/components/segmental";
import { SetupNotice } from "@/components/setup-notice";
import { POST as postManualEntry } from "@/app/api/measurements/manual/route";
import { DELETE as deleteMeasurementRow } from "@/app/api/measurements/[id]/route";

export const dynamic = "force-dynamic";

const CLINIC_TZ = "Europe/Madrid";

const SOURCE_LABEL: Record<string, string> = {
  inbody: "InBody",
  manual_log: "Báscula",
  apple_health: "Apple Health",
};

const SOURCE_FILTERS: { value: string; label: string }[] = [
  { value: "todas", label: "Todas" },
  { value: "inbody", label: "InBody" },
  { value: "manual_log", label: "Báscula" },
  { value: "apple_health", label: "Apple Health" },
];

const n = (v: string | null) => (v === null ? null : Number(v));
const fmt1 = (v: number | null) => (v === null ? "—" : v.toFixed(1));

/** manual_log entries carry a synthetic noon timestamp, so only real clinic times are shown. */
function fmtFecha(d: Date, source: string): string {
  return d.toLocaleString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(source !== "manual_log" ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: CLINIC_TZ,
  });
}

function todayInMadrid(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TZ }).format(new Date());
}

/** Builds the /measurements?source=... URL a Server Action should return to after acting. */
function backTo(source: string, extra: Record<string, string>): string {
  const params = new URLSearchParams(extra);
  if (source !== "todas") params.set("source", source);
  const qs = params.toString();
  return qs ? `/measurements?${qs}` : "/measurements";
}

/**
 * Registers a home weigh-in.
 *
 * Implemented as an inline Server Action rather than client-side `fetch` so this page can
 * stay a Server Component (required for the direct, always-fresh listing query below) while
 * still working with JavaScript disabled. It calls the exact POST handler that backs
 * `/api/measurements/manual` — the same validation, the same trust boundary, no duplicated
 * rules — via an in-process Request rather than a real HTTP round trip, since a self-fetch
 * from inside the server would otherwise be bounced by the app's own login gate (which has
 * no session cookie to forward).
 */
async function createManualEntry(formData: FormData): Promise<void> {
  "use server";

  const currentSource = String(formData.get("currentSource") ?? "todas");
  const str = (key: string): string | undefined => {
    const v = formData.get(key);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  };
  const numField = (key: string): number | undefined => {
    const v = str(key);
    return v === undefined ? undefined : Number(v);
  };

  const payload = {
    date: str("date") ?? "",
    weightKg: numField("weightKg"),
    bodyFatPct: numField("bodyFatPct"),
    skeletalMuscleMassKg: numField("skeletalMuscleMassKg"),
    note: str("note"),
  };

  const request = new Request("http://internal.local/api/measurements/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  let errorMessage: string | null = null;
  try {
    const response = await postManualEntry(request);
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as
        | { error?: string; issues?: { message?: string }[] }
        | null;
      errorMessage = json?.issues?.[0]?.message ?? json?.error ?? "No se pudo guardar la medición.";
    }
  } catch {
    errorMessage = "No se pudo guardar la medición.";
  }

  revalidatePath("/measurements");
  if (errorMessage) redirect(backTo(currentSource, { formError: errorMessage }));
  redirect(backTo(currentSource, { saved: "1" }));
}

/**
 * Deletes one measurement. Same in-process-call rationale as `createManualEntry` above —
 * this calls the real DELETE handler behind `/api/measurements/[id]`, so id validation and
 * the 404 behaviour are exactly what the standalone endpoint does.
 */
async function deleteEntry(formData: FormData): Promise<void> {
  "use server";

  const currentSource = String(formData.get("currentSource") ?? "todas");
  const rawId = String(formData.get("id") ?? "");

  const request = new Request(`http://internal.local/api/measurements/${rawId}`, {
    method: "DELETE",
  });

  let errorMessage: string | null = null;
  try {
    const response = await deleteMeasurementRow(request, { params: Promise.resolve({ id: rawId }) });
    if (!response.ok) {
      const json = (await response.json().catch(() => null)) as { error?: string } | null;
      errorMessage = json?.error ?? "No se pudo eliminar la medición.";
    }
  } catch {
    errorMessage = "No se pudo eliminar la medición.";
  }

  revalidatePath("/measurements");
  if (errorMessage) redirect(backTo(currentSource, { formError: errorMessage }));
  redirect(backTo(currentSource, { deleted: "1" }));
}

export default async function MeasurementsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // Checked before touching `db`, for the same reason as the dashboard.
  if (!isDatabaseConfigured()) return <SetupNotice />;

  const sp = await searchParams;
  const sourceRaw = sp.source;
  const sourceParam = typeof sourceRaw === "string" ? sourceRaw : "todas";
  const formError = typeof sp.formError === "string" ? sp.formError : null;
  const saved = sp.saved === "1";
  const deletedFlag = sp.deleted === "1";

  const rows: Measurement[] = await db
    .select()
    .from(measurements)
    .orderBy(desc(measurements.measuredAt), desc(measurements.id));

  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});

  const filtered = sourceParam === "todas" ? rows : rows.filter((r) => r.source === sourceParam);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6">
        <Link href="/" className="text-sm text-ink-secondary hover:underline">
          ← Volver
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">Mediciones</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          {rows.length} mediciones en total · InBody {counts.inbody ?? 0} · Báscula{" "}
          {counts.manual_log ?? 0} · Apple Health {counts.apple_health ?? 0}
        </p>
      </header>

      {formError ? (
        <p
          className="mb-4 rounded-lg border p-3 text-sm"
          style={{ borderColor: "var(--status-critical)", color: "var(--status-critical)" }}
        >
          {formError}
        </p>
      ) : null}
      {saved ? (
        <p
          className="mb-4 rounded-lg border p-3 text-sm"
          style={{ borderColor: "var(--status-good)", color: "var(--status-good)" }}
        >
          Medición guardada.
        </p>
      ) : null}
      {deletedFlag ? (
        <p className="mb-4 rounded-lg border border-hairline bg-surface p-3 text-sm text-ink-secondary">
          Medición eliminada.
        </p>
      ) : null}

      <section className="mb-8 rounded-xl border border-hairline bg-surface p-4 sm:p-5">
        <h2 className="mb-1 text-base font-semibold text-ink">Registrar peso</h2>
        <p className="mb-3 text-xs text-ink-secondary">
          Así se registra un pesaje normal en casa. Indica al menos un valor.
        </p>
        <form action={createManualEntry} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="currentSource" value={sourceParam} />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-secondary">Fecha</span>
            <input
              type="date"
              name="date"
              required
              max={todayInMadrid()}
              className="w-full rounded-lg border border-hairline bg-page px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-secondary">Peso (kg)</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min={20}
              max={400}
              name="weightKg"
              placeholder="—"
              className="w-full rounded-lg border border-hairline bg-page px-3 py-2 text-sm tabular-nums text-ink"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-secondary">
              % grasa corporal <span className="text-ink-muted">(opcional)</span>
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min={1}
              max={70}
              name="bodyFatPct"
              placeholder="—"
              className="w-full rounded-lg border border-hairline bg-page px-3 py-2 text-sm tabular-nums text-ink"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-ink-secondary">
              Masa muscular (kg) <span className="text-ink-muted">(opcional)</span>
            </span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min={5}
              max={100}
              name="skeletalMuscleMassKg"
              placeholder="—"
              className="w-full rounded-lg border border-hairline bg-page px-3 py-2 text-sm tabular-nums text-ink"
            />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-xs font-medium text-ink-secondary">
              Nota <span className="text-ink-muted">(opcional)</span>
            </span>
            <input
              type="text"
              name="note"
              maxLength={500}
              className="w-full rounded-lg border border-hairline bg-page px-3 py-2 text-sm text-ink"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              className="rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ background: "var(--series-weight)" }}
            >
              Guardar
            </button>
          </div>
        </form>
      </section>

      <div className="mb-4 flex flex-wrap gap-2">
        {SOURCE_FILTERS.map((f) => {
          const active = sourceParam === f.value;
          const count = f.value === "todas" ? rows.length : (counts[f.value] ?? 0);
          return (
            <Link
              key={f.value}
              href={f.value === "todas" ? "/measurements" : `/measurements?source=${f.value}`}
              className="rounded-full border px-3 py-1 text-xs font-medium"
              style={
                active
                  ? { borderColor: "var(--series-weight)", color: "var(--series-weight)" }
                  : { borderColor: "var(--border)", color: "var(--text-secondary)" }
              }
            >
              {f.label} ({count})
            </Link>
          );
        })}
      </div>

      <section
        aria-label="Listado de mediciones"
        className="rounded-xl border border-hairline bg-surface p-4 sm:p-5"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-ink-secondary">
                <th className="py-2 pr-3 font-medium">Fecha</th>
                <th className="py-2 pr-3 font-medium">Origen</th>
                <th className="py-2 pr-3 text-right font-medium">Peso</th>
                <th className="py-2 pr-3 text-right font-medium">% grasa</th>
                <th className="py-2 pr-3 text-right font-medium">Masa muscular</th>
                <th className="py-2 pr-3 font-medium">Nota</th>
                <th className="py-2 font-medium">
                  <span className="sr-only">Acciones</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-sm text-ink-secondary">
                    No hay mediciones para este filtro.
                  </td>
                </tr>
              ) : null}
              {filtered.map((m) => {
                const dateLabel = fmtFecha(m.measuredAt, m.source);
                return (
                  <Fragment key={m.id}>
                    <tr className="border-b border-hairline/60 align-top">
                      <td className="py-2 pr-3 whitespace-nowrap text-ink">{dateLabel}</td>
                      <td className="py-2 pr-3 whitespace-nowrap text-ink-secondary">
                        {SOURCE_LABEL[m.source] ?? m.source}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink">{fmt1(n(m.weightKg))}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink">
                        {n(m.bodyFatPct) !== null ? `${fmt1(n(m.bodyFatPct))}%` : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-ink">
                        {fmt1(n(m.skeletalMuscleMassKg))}
                      </td>
                      <td className="py-2 pr-3 max-w-[16rem] text-ink-secondary">{m.note ?? "—"}</td>
                      <td className="py-2 text-right">
                        <details className="inline-block text-left">
                          <summary className="cursor-pointer list-none rounded-lg border border-hairline px-2 py-1 text-xs font-medium text-ink-secondary marker:content-none">
                            Eliminar
                          </summary>
                          <form
                            action={deleteEntry}
                            className="mt-2 w-56 rounded-lg border border-hairline bg-page p-3"
                          >
                            <input type="hidden" name="id" value={m.id} />
                            <input type="hidden" name="currentSource" value={sourceParam} />
                            <p className="mb-2 text-xs text-ink-secondary">
                              ¿Eliminar la medición del {dateLabel}? Esta acción no se puede deshacer.
                            </p>
                            <button
                              type="submit"
                              className="w-full rounded-lg border px-3 py-1.5 text-xs font-medium"
                              style={{ borderColor: "var(--status-critical)", color: "var(--status-critical)" }}
                            >
                              Sí, eliminar definitivamente
                            </button>
                          </form>
                        </details>
                      </td>
                    </tr>
                    {m.segmental ? (
                      <tr className="border-b border-hairline/60">
                        <td colSpan={7} className="pb-3">
                          <details>
                            <summary className="cursor-pointer py-1 text-xs font-medium text-ink-secondary">
                              Ver desglose segmental
                            </summary>
                            <SegmentalView segmental={m.segmental} className="mt-2" />
                          </details>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
