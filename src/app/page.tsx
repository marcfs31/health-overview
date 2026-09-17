import { asc } from "drizzle-orm";
import { db, measurements } from "@/lib/db";
import {
  movingAverage,
  rapidSwings,
  summarise,
  toDailySeries,
  type Reading,
} from "@/lib/stats";
import { BodyFatChart, CompositionChart, WeightChart, type ChartPoint } from "@/components/charts";
import { InsightsPanel } from "@/components/insights";

export const dynamic = "force-dynamic";

const n = (v: string | null) => (v === null ? null : Number(v));

const fmtDate = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

function StatTile({
  label,
  value,
  unit,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit?: string;
  detail?: string;
  tone?: "neutral" | "good" | "warning";
}) {
  const toneColor =
    tone === "good"
      ? "var(--status-good)"
      : tone === "warning"
        ? "var(--status-warning)"
        : "var(--text-primary)";
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <p className="text-xs font-medium text-ink-secondary">{label}</p>
      <p className="mt-1 text-2xl font-semibold" style={{ color: toneColor }}>
        {value}
        {unit ? <span className="ml-1 text-base font-normal text-ink-secondary">{unit}</span> : null}
      </p>
      {detail ? <p className="mt-1 text-xs text-ink-muted">{detail}</p> : null}
    </div>
  );
}

export default async function Dashboard() {
  const rows = await db.select().from(measurements).orderBy(asc(measurements.measuredAt));

  const readings: Reading[] = rows.map((r) => ({
    measuredAt: r.measuredAt,
    source: r.source,
    weightKg: n(r.weightKg),
    bodyFatPct: n(r.bodyFatPct),
    skeletalMuscleMassKg: n(r.skeletalMuscleMassKg),
    bodyFatMassKg: n(r.bodyFatMassKg),
    fatFreeMassKg: n(r.fatFreeMassKg),
  }));

  const points = toDailySeries(readings);
  const trend = movingAverage(points);
  const stats = summarise(points);
  const swings = rapidSwings(points).slice(-3);

  // The device reports fat mass on only 4 of the 13 scans, but body-fat % is on all
  // of them — so the split is derived where it wasn't printed, and the reported
  // value wins whenever the device actually gave one.
  const chartPoints: ChartPoint[] = points.map((p) => {
    const fatMass =
      p.bodyFatMassKg ??
      (p.weightKg !== null && p.bodyFatPct !== null
        ? Number(((p.weightKg * p.bodyFatPct) / 100).toFixed(2))
        : null);
    const leanMass =
      p.weightKg !== null && fatMass !== null ? Number((p.weightKg - fatMass).toFixed(2)) : null;
    return {
      t: p.t,
      day: p.day,
      weightKg: p.weightKg,
      bodyFatPct: p.bodyFatPct,
      fatMassKg: fatMass,
      leanMassKg: leanMass,
    };
  });

  const scans = chartPoints.filter((p) => p.bodyFatPct !== null);
  const latest = stats.latest;
  const firstScan = stats.firstScan;
  const latestScan = stats.latestScan;

  const fromPeak =
    latest && stats.peak ? Number((latest.weightKg! - stats.peak.weightKg!).toFixed(1)) : null;
  const fatPctDelta =
    latestScan && firstScan
      ? Number((latestScan.bodyFatPct! - firstScan.bodyFatPct!).toFixed(1))
      : null;

  const latestLean = scans.at(-1)?.leanMassKg ?? null;
  const firstLean = scans.at(0)?.leanMassKg ?? null;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-ink">Health Overview</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          {stats.totalReadings} mediciones · {points[0] ? fmtDate(points[0].day) : "—"} →{" "}
          {latest ? fmtDate(latest.day) : "—"}
        </p>
      </header>

      <section aria-label="Resumen" className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Peso actual"
          value={latest?.weightKg?.toFixed(1) ?? "—"}
          unit="kg"
          detail={latest ? fmtDate(latest.day) : undefined}
        />
        <StatTile
          label="Grasa corporal"
          value={latestScan?.bodyFatPct?.toFixed(1) ?? "—"}
          unit="%"
          detail={
            fatPctDelta !== null && firstScan
              ? `${fatPctDelta > 0 ? "+" : ""}${fatPctDelta} pts desde ${fmtDate(firstScan.day)}`
              : undefined
          }
          tone={latestScan && latestScan.bodyFatPct! <= 20 ? "good" : "neutral"}
        />
        <StatTile
          label="Masa magra"
          value={latestLean?.toFixed(1) ?? "—"}
          unit="kg"
          detail={
            latestLean !== null && firstLean !== null
              ? `${latestLean - firstLean > 0 ? "+" : ""}${(latestLean - firstLean).toFixed(1)} kg desde el primer escáner`
              : undefined
          }
        />
        <StatTile
          label="Desde el pico"
          value={fromPeak !== null ? fromPeak.toFixed(1) : "—"}
          unit="kg"
          detail={
            stats.peak
              ? `Pico ${stats.peak.weightKg!.toFixed(1)} kg · ${fmtDate(stats.peak.day)}`
              : undefined
          }
          tone={fromPeak !== null && fromPeak < 0 ? "good" : "neutral"}
        />
      </section>

      <section className="mb-8">
        <InsightsPanel />
      </section>

      <section className="mb-8 grid gap-4">
        <WeightChart points={chartPoints} trend={trend} />
        <div className="grid gap-4 lg:grid-cols-2">
          <CompositionChart scans={scans} />
          <BodyFatChart scans={scans} />
        </div>
      </section>

      {swings.length > 0 ? (
        <section
          aria-label="Variaciones rápidas"
          className="mb-8 rounded-xl border border-hairline bg-surface p-4 sm:p-5"
        >
          <h2 className="text-base font-semibold text-ink">Variaciones rápidas recientes</h2>
          <p className="mt-0.5 mb-3 text-xs text-ink-secondary">
            Cambios de 2 kg o más en 10 días o menos. A esa velocidad es agua, glucógeno o
            condiciones de pesaje — no grasa ganada ni perdida.
          </p>
          <ul className="space-y-2">
            {swings.map((s) => (
              <li key={`${s.from.day}-${s.to.day}`} className="flex items-baseline gap-2 text-sm">
                <span
                  aria-hidden
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ background: "var(--status-warning)" }}
                />
                <span className="font-medium tabular-nums text-ink">
                  {s.deltaKg > 0 ? "+" : ""}
                  {s.deltaKg} kg
                </span>
                <span className="text-ink-secondary">
                  en {s.days} días · {fmtDate(s.from.day)} → {fmtDate(s.to.day)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-label="Mediciones"
        className="rounded-xl border border-hairline bg-surface p-4 sm:p-5"
      >
        <h2 className="mb-3 text-base font-semibold text-ink">Últimas mediciones</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs text-ink-secondary">
                <th className="py-2 pr-3 font-medium">Fecha</th>
                <th className="py-2 pr-3 font-medium">Origen</th>
                <th className="py-2 pr-3 text-right font-medium">Peso</th>
                <th className="py-2 pr-3 text-right font-medium">Grasa</th>
                <th className="py-2 text-right font-medium">Magra</th>
              </tr>
            </thead>
            <tbody>
              {chartPoints
                .slice(-12)
                .reverse()
                .map((p) => (
                  <tr key={p.day} className="border-b border-hairline/60 last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap text-ink">{fmtDate(p.day)}</td>
                    <td className="py-2 pr-3 text-ink-secondary">
                      {points.find((q) => q.day === p.day)?.source === "inbody"
                        ? "InBody"
                        : "Báscula"}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-ink">
                      {p.weightKg?.toFixed(1) ?? "—"}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-ink">
                      {p.bodyFatPct !== null ? `${p.bodyFatPct.toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums text-ink">
                      {p.leanMassKg?.toFixed(1) ?? "—"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
