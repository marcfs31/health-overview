import { asc } from "drizzle-orm";
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { db, measurements } from "@/lib/db";
import {
  rapidSwings,
  summarise,
  toDailySeries,
  trendRateKgPerWeek,
  type DailyPoint,
  type Reading,
} from "@/lib/stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

const n = (v: string | null) => (v === null ? null : Number(v));

const round1 = (v: number | null): number | null => (v === null ? null : Number(v.toFixed(1)));

/**
 * Fat mass in kg. The device's own figure wins when it printed one; otherwise it's
 * derived from weight × body-fat % — the same rule src/app/page.tsx uses for the charts.
 */
function fatMassKg(p: DailyPoint): number | null {
  if (p.bodyFatMassKg !== null) return p.bodyFatMassKg;
  if (p.weightKg !== null && p.bodyFatPct !== null) {
    return Number(((p.weightKg * p.bodyFatPct) / 100).toFixed(2));
  }
  return null;
}

function leanMassKg(p: DailyPoint): number | null {
  const fat = fatMassKg(p);
  if (p.weightKg === null || fat === null) return null;
  return Number((p.weightKg - fat).toFixed(2));
}

function longestGapDays(points: DailyPoint[]): number | null {
  const withWeight = points.filter((p) => p.weightKg !== null);
  if (withWeight.length < 2) return null;
  let longest = 0;
  for (let i = 1; i < withWeight.length; i++) {
    const gap = Math.round((withWeight[i].t - withWeight[i - 1].t) / DAY_MS);
    if (gap > longest) longest = gap;
  }
  return longest;
}

export type InsightsStats = {
  currentWeightKg: number | null;
  currentWeightDate: string | null;

  rateKgPerWeek90d: number | null;
  rateKgPerWeek30d: number | null;

  isPlateau: boolean;

  changeFromPeakKg: number | null;
  peakWeightKg: number | null;
  peakDate: string | null;

  changeFromLowKg: number | null;
  lowWeightKg: number | null;
  lowDate: string | null;

  bodyFat: {
    latestPct: number | null;
    latestDate: string | null;
    changeSincePreviousScanPct: number | null;
    changeSinceFirstScanPct: number | null;
    firstScanDate: string | null;
  };

  leanMass: {
    nowKg: number | null;
    atFirstScanKg: number | null;
    changeKg: number | null;
  };

  recentRapidSwings: { fromDate: string; toDate: string; deltaKg: number; days: number }[];

  longestGapDays: number | null;
  daysSinceLastReading: number | null;

  totalReadings: number;
};

type NarrativeUnavailable = "no_api_key" | "error" | null;

export type InsightsResponse = {
  stats: InsightsStats;
  narrative: string | null;
  narrativeUnavailable: NarrativeUnavailable;
};

/** Step 1 — everything here is arithmetic over src/lib/stats.ts output. No LLM involved. */
async function computeStats(): Promise<InsightsStats> {
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
  const base = summarise(points);
  const scans = points.filter((p) => p.bodyFatPct !== null);

  const { latest, peak, lowest, firstScan, latestScan } = base;
  const previousScan = scans.length >= 2 ? scans[scans.length - 2] : null;

  const daysSinceLastReading = latest ? Math.round((Date.now() - latest.t) / DAY_MS) : null;

  const leanNow = latestScan ? leanMassKg(latestScan) : null;
  const leanFirst = firstScan ? leanMassKg(firstScan) : null;

  return {
    currentWeightKg: latest?.weightKg ?? null,
    currentWeightDate: latest?.day ?? null,

    rateKgPerWeek90d: trendRateKgPerWeek(points, 90),
    rateKgPerWeek30d: trendRateKgPerWeek(points, 30),

    isPlateau: base.plateau,

    changeFromPeakKg: latest && peak ? round1(latest.weightKg! - peak.weightKg!) : null,
    peakWeightKg: peak?.weightKg ?? null,
    peakDate: peak?.day ?? null,

    changeFromLowKg: latest && lowest ? round1(latest.weightKg! - lowest.weightKg!) : null,
    lowWeightKg: lowest?.weightKg ?? null,
    lowDate: lowest?.day ?? null,

    bodyFat: {
      latestPct: latestScan?.bodyFatPct ?? null,
      latestDate: latestScan?.day ?? null,
      changeSincePreviousScanPct:
        latestScan && previousScan
          ? round1(latestScan.bodyFatPct! - previousScan.bodyFatPct!)
          : null,
      changeSinceFirstScanPct:
        latestScan && firstScan ? round1(latestScan.bodyFatPct! - firstScan.bodyFatPct!) : null,
      firstScanDate: firstScan?.day ?? null,
    },

    leanMass: {
      nowKg: leanNow,
      atFirstScanKg: leanFirst,
      changeKg: leanNow !== null && leanFirst !== null ? round1(leanNow - leanFirst) : null,
    },

    recentRapidSwings: rapidSwings(points)
      .slice(-3)
      .map((s) => ({
        fromDate: s.from.day,
        toDate: s.to.day,
        deltaKg: s.deltaKg,
        days: s.days,
      })),

    longestGapDays: longestGapDays(points),
    daysSinceLastReading,

    totalReadings: base.totalReadings,
  };
}

const NARRATIVE_SYSTEM = `Eres un asistente que interpreta en voz alta, en español, los datos ya calculados del seguimiento de composición corporal de un usuario.

Reglas estrictas:
- Dirígete al usuario en segunda persona ("has bajado...", "tu ritmo...", "llevas...").
- Interpreta tendencias (ritmo de cambio, mesetas, rachas rápidas) en español sencillo y directo.
- Un cambio rápido de peso en pocos días (definido como tal en los datos) es agua o glucógeno, nunca grasa ganada o perdida — dilo explícitamente si aparece alguno.
- NUNCA des consejo médico, NUNCA diagnostiques nada, NUNCA prescribas dietas, déficits o objetivos calóricos. No sugieras qué debería hacer el usuario a continuación.
- No inventes cifras: usa únicamente los números que se te proporcionan.
- Máximo ~120 palabras. Sin listas, un párrafo corrido, tono cercano pero neutro.`;

/**
 * Step 2 (optional) — short Spanish narrative over the numbers computed in Step 1.
 * Only the computed stats are sent, never the raw measurement rows.
 */
async function generateNarrative(stats: InsightsStats): Promise<string | null> {
  const client = new Anthropic();
  const model = process.env.INSIGHTS_MODEL ?? "claude-sonnet-5";

  const response = await client.messages.create({
    model,
    max_tokens: 600,
    system: NARRATIVE_SYSTEM,
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: `Estas son las cifras ya calculadas a partir de mi historial de peso y composición corporal. Escribe la interpretación siguiendo tus reglas:\n\n${JSON.stringify(stats, null, 2)}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") return null;

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock && "text" in textBlock ? textBlock.text.trim() : "";
  return text.length > 0 ? text : null;
}

export async function GET() {
  // Step 1 is the product: it must always succeed and always return 200.
  const stats = await computeStats();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json<InsightsResponse>({
      stats,
      narrative: null,
      narrativeUnavailable: "no_api_key",
    });
  }

  // Step 2 is a bonus: any failure here must never break the panel.
  try {
    const narrative = await generateNarrative(stats);
    return NextResponse.json<InsightsResponse>({
      stats,
      narrative,
      narrativeUnavailable: narrative ? null : "error",
    });
  } catch {
    return NextResponse.json<InsightsResponse>({
      stats,
      narrative: null,
      narrativeUnavailable: "error",
    });
  }
}
