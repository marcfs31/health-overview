"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export type ChartPoint = {
  t: number;
  day: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  fatMassKg: number | null;
  leanMassKg: number | null;
};

const fmtYear = (t: number) => new Date(t).getUTCFullYear().toString();

const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

function ChartFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="m-0 rounded-xl border border-hairline bg-surface p-4 sm:p-5">
      <figcaption className="mb-4">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-secondary">{subtitle}</p>
      </figcaption>
      <div className="h-64 w-full sm:h-72">{children}</div>
    </figure>
  );
}

type TooltipRow = { name: string; value: number | null; color: string; unit: string };

function Tip({
  active,
  label,
  rows,
}: {
  active?: boolean;
  label?: number;
  rows: TooltipRow[];
}) {
  if (!active || label === undefined) return null;
  const shown = rows.filter((r) => r.value !== null && r.value !== undefined);
  if (!shown.length) return null;
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-ink">{fmtDay(label)}</p>
      {shown.map((r) => (
        <p key={r.name} className="flex items-center gap-2 text-ink-secondary">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ background: r.color }}
          />
          {r.name}:{" "}
          <span className="font-medium tabular-nums text-ink">
            {r.value!.toFixed(1)}
            {r.unit}
          </span>
        </p>
      ))}
    </div>
  );
}

const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: "var(--muted)", fontSize: 11 },
  tickLine: false,
};

/** One tick per January — otherwise Recharts ticks each data point and repeats years. */
function yearTicks(points: { t: number }[]): number[] {
  if (!points.length) return [];
  const first = new Date(points[0].t).getUTCFullYear();
  const last = new Date(points[points.length - 1].t).getUTCFullYear();
  const ticks: number[] = [];
  for (let y = first; y <= last; y++) {
    const t = Date.UTC(y, 0, 1);
    if (t >= points[0].t && t <= points[points.length - 1].t) ticks.push(t);
  }
  return ticks;
}

const timeAxis = (points: { t: number }[]) => ({
  dataKey: "t",
  type: "number" as const,
  domain: ["dataMin", "dataMax"] as [string, string],
  scale: "time" as const,
  ticks: yearTicks(points),
  tickFormatter: fmtYear,
  ...axisProps,
});

// A negative left margin clips the y-axis labels out of the SVG viewport.
const chartMargin = { top: 8, right: 12, bottom: 0, left: 4 };

export function WeightChart({
  points,
  trend,
}: {
  points: ChartPoint[];
  trend: { t: number; value: number }[];
}) {
  const trendByT = new Map(trend.map((m) => [m.t, m.value]));
  const merged = points.map((p) => ({ ...p, trend: trendByT.get(p.t) ?? null }));

  return (
    <ChartFrame
      title="Peso"
      subtitle="Cada pesaje registrado, con la media móvil de 6 semanas. Las lecturas sueltas oscilan por agua y horario; la línea es la señal real."
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={merged} margin={chartMargin}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis {...timeAxis(merged)} />
          <YAxis
            {...axisProps}
            domain={["dataMin - 3", "dataMax + 3"]}
            tickFormatter={(v: number) => `${Math.round(v)}`}
            width={46}
          />
          <Tooltip
            content={({ active, label, payload }) => (
              <Tip
                active={active}
                label={label as number}
                rows={[
                  {
                    name: "Pesaje",
                    value: (payload?.[0]?.payload?.weightKg as number) ?? null,
                    color: "var(--series-weight)",
                    unit: " kg",
                  },
                  {
                    name: "Media 6 sem.",
                    value: (payload?.[0]?.payload?.trend as number) ?? null,
                    color: "var(--series-weight)",
                    unit: " kg",
                  },
                ]}
              />
            )}
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
          />
          <Legend
            verticalAlign="top"
            align="left"
            height={28}
            iconType="plainline"
            wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }}
          />
          <Scatter
            name="Pesaje registrado"
            dataKey="weightKg"
            fill="var(--series-weight)"
            fillOpacity={0.35}
            shape="circle"
            legendType="circle"
          />
          <Line
            name="Media 6 semanas"
            type="monotone"
            dataKey="trend"
            stroke="var(--series-weight)"
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function CompositionChart({ scans }: { scans: ChartPoint[] }) {
  return (
    <ChartFrame
      title="Composición corporal"
      subtitle="Masa magra y masa grasa en kg — juntas suman tu peso. Sólo escáneres InBody, que son los que miden el reparto."
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={scans} margin={chartMargin}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis {...timeAxis(scans)} />
          <YAxis {...axisProps} width={46} />
          <Tooltip
            content={({ active, label, payload }) => (
              <Tip
                active={active}
                label={label as number}
                rows={[
                  {
                    name: "Masa magra",
                    value: (payload?.[0]?.payload?.leanMassKg as number) ?? null,
                    color: "var(--series-lean)",
                    unit: " kg",
                  },
                  {
                    name: "Masa grasa",
                    value: (payload?.[0]?.payload?.fatMassKg as number) ?? null,
                    color: "var(--series-fat)",
                    unit: " kg",
                  },
                ]}
              />
            )}
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
          />
          <Legend
            verticalAlign="top"
            align="left"
            height={28}
            wrapperStyle={{ fontSize: 12, color: "var(--text-secondary)" }}
          />
          <Area
            name="Masa magra"
            type="monotone"
            dataKey="leanMassKg"
            stackId="body"
            stroke="var(--surface-1)"
            strokeWidth={2}
            fill="var(--series-lean)"
            fillOpacity={0.9}
            connectNulls
          />
          <Area
            name="Masa grasa"
            type="monotone"
            dataKey="fatMassKg"
            stackId="body"
            stroke="var(--surface-1)"
            strokeWidth={2}
            fill="var(--series-fat)"
            fillOpacity={0.9}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export function BodyFatChart({ scans }: { scans: ChartPoint[] }) {
  return (
    <ChartFrame
      title="Porcentaje de grasa"
      subtitle="En su propio gráfico a propósito: mezclar % y kg en un eje doble es la forma más rápida de leer mal una tendencia."
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={scans} margin={chartMargin}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis {...timeAxis(scans)} />
          <YAxis
            {...axisProps}
            width={46}
            domain={[0, "dataMax + 5"]}
            tickFormatter={(v: number) => `${Math.round(v)}%`}
          />
          <Tooltip
            content={({ active, label, payload }) => (
              <Tip
                active={active}
                label={label as number}
                rows={[
                  {
                    name: "Grasa corporal",
                    value: (payload?.[0]?.payload?.bodyFatPct as number) ?? null,
                    color: "var(--series-fat)",
                    unit: " %",
                  },
                ]}
              />
            )}
            cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
          />
          <Line
            name="Grasa corporal"
            type="monotone"
            dataKey="bodyFatPct"
            stroke="var(--series-fat)"
            strokeWidth={2}
            dot={{ r: 4, fill: "var(--series-fat)", stroke: "var(--surface-1)", strokeWidth: 2 }}
            activeDot={{ r: 6 }}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
