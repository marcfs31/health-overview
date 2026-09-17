"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { InsightsResponse } from "@/app/api/insights/route";

const LONG_GAP_DAYS = 14;

type Tone = "good" | "warning" | "neutral";

function toneColor(tone: Tone): string {
  if (tone === "good") return "var(--status-good)";
  if (tone === "warning") return "var(--status-warning)";
  return "var(--text-primary)";
}

function fmtDate(day: string | null): string {
  if (!day) return "—";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function signed(v: number | null, digits = 1): string {
  if (v === null) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
}

function daysAgoLabel(days: number): string {
  if (days <= 0) return "Hoy";
  if (days === 1) return "Hace 1 día";
  return `Hace ${days} días`;
}

function Tile({
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
  tone?: Tone;
}) {
  return (
    <div className="rounded-xl border border-hairline bg-surface p-4">
      <p className="text-xs font-medium text-ink-secondary">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums" style={{ color: toneColor(tone) }}>
        {value}
        {unit ? (
          <span className="ml-1 text-sm font-normal text-ink-secondary">{unit}</span>
        ) : null}
      </p>
      {detail ? <p className="mt-1 text-xs text-ink-muted">{detail}</p> : null}
    </div>
  );
}

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-xs font-medium text-ink"
    >
      <span
        aria-hidden
        className="inline-block size-1.5 shrink-0 rounded-full"
        style={{ background: toneColor(tone) }}
      />
      {children}
    </span>
  );
}

function PanelShell({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Análisis"
      className="grid gap-4 rounded-xl border border-hairline bg-surface p-4 sm:p-5"
    >
      {children}
    </section>
  );
}

export function InsightsPanel() {
  const [data, setData] = useState<InsightsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch("/api/insights");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as InsightsResponse;
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <PanelShell>
        <h2 className="text-base font-semibold text-ink">Análisis</h2>
        <p className="text-sm text-ink-secondary">Calculando el análisis…</p>
      </PanelShell>
    );
  }

  if (failed || !data) {
    return (
      <PanelShell>
        <h2 className="text-base font-semibold text-ink">Análisis</h2>
        <p className="text-sm text-ink-secondary">
          No se ha podido cargar el análisis ahora mismo. Vuelve a intentarlo más tarde.
        </p>
      </PanelShell>
    );
  }

  const { stats, narrative, narrativeUnavailable } = data;

  const rate = stats.rateKgPerWeek30d ?? stats.rateKgPerWeek90d;
  const rateTone: Tone = rate !== null && rate < 0 ? "good" : "neutral";

  const hasSwings = stats.recentRapidSwings.length > 0;
  const longGap = stats.daysSinceLastReading !== null && stats.daysSinceLastReading > LONG_GAP_DAYS;

  return (
    <PanelShell>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink">Análisis</h2>
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">{stats.isPlateau ? "En meseta" : "Sin meseta"}</Badge>
          {hasSwings ? <Badge tone="warning">Variación rápida reciente</Badge> : null}
          {longGap ? <Badge tone="warning">Sin mediciones recientes</Badge> : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Ritmo (30 días)"
          value={stats.rateKgPerWeek30d !== null ? signed(stats.rateKgPerWeek30d) : "—"}
          unit="kg/sem"
          detail={
            stats.rateKgPerWeek90d !== null
              ? `${signed(stats.rateKgPerWeek90d)} kg/sem en 90 días`
              : undefined
          }
          tone={rateTone}
        />
        <Tile
          label="Desde el mínimo"
          value={stats.changeFromLowKg !== null ? signed(stats.changeFromLowKg) : "—"}
          unit="kg"
          detail={
            stats.lowWeightKg !== null
              ? `Mínimo ${stats.lowWeightKg.toFixed(1)} kg · ${fmtDate(stats.lowDate)}`
              : undefined
          }
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Tile
          label="Última medición"
          value={fmtDate(stats.currentWeightDate)}
          detail={
            stats.daysSinceLastReading !== null ? daysAgoLabel(stats.daysSinceLastReading) : undefined
          }
          tone={longGap ? "warning" : "neutral"}
        />
        <Tile
          label="Mayor hueco"
          value={stats.longestGapDays !== null ? String(stats.longestGapDays) : "—"}
          unit="días"
          detail="Entre dos mediciones consecutivas"
        />
      </div>

      {hasSwings ? (
        <div className="rounded-lg border border-hairline p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-secondary">
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-full"
              style={{ background: "var(--status-warning)" }}
            />
            Variaciones rápidas recientes
          </p>
          <ul className="space-y-1 text-sm text-ink">
            {stats.recentRapidSwings.map((s) => (
              <li key={`${s.fromDate}-${s.toDate}`} className="tabular-nums">
                {signed(s.deltaKg)} kg en {s.days} días ({fmtDate(s.fromDate)} → {fmtDate(s.toDate)})
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-ink-muted">
            A ese ritmo es agua o glucógeno, no grasa ganada ni perdida.
          </p>
        </div>
      ) : null}

      {narrative ? (
        <div className="rounded-lg border border-hairline p-3">
          <p className="text-sm leading-relaxed text-ink">{narrative}</p>
        </div>
      ) : narrativeUnavailable === "no_api_key" ? (
        <p className="text-xs text-ink-muted">
          Configura la variable de entorno ANTHROPIC_API_KEY para activar el resumen escrito. Las
          estadísticas de arriba funcionan igual sin ella.
        </p>
      ) : narrativeUnavailable === "error" ? (
        <p className="text-xs text-ink-muted">
          No se ha podido generar el resumen escrito en este momento.
        </p>
      ) : null}
    </PanelShell>
  );
}
