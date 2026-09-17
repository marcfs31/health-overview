import { NextResponse } from "next/server";
import { z } from "zod";
import { db, measurements, type NewMeasurement } from "@/lib/db";

export const runtime = "nodejs";

const MAX_DAYS_PER_REQUEST = 500;
const MADRID_TZ = "Europe/Madrid";

const DaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato de fecha inválido"),
  weightKg: z.number().nullable(),
  bodyFatPct: z.number().nullable(),
  leanBodyMassKg: z.number().nullable(),
});

const BodySchema = z.object({
  days: z.array(DaySchema).max(MAX_DAYS_PER_REQUEST, "Máximo 500 días por petición"),
});

/**
 * Apple Health days arrive with no time-of-day (they were already aggregated to one value
 * per calendar day in the browser). Store each at 12:00 local Europe/Madrid — noon keeps
 * the calendar date stable no matter which timezone later renders it, same convention as
 * scripts/seed.ts (manual log) and the clinicTimeToDate() helper in api/measurements.
 */
function noonMadrid(day: string): Date {
  const asUtc = new Date(`${day}T12:00:00Z`);
  const inTz = new Date(asUtc.toLocaleString("en-US", { timeZone: MADRID_TZ }));
  const inUtc = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(asUtc.getTime() - (inTz.getTime() - inUtc.getTime()));
}

const num = (v: number | null) => (v === null ? null : String(v));

/**
 * This is a trust boundary: `days` comes from the client's own parse of an arbitrary file
 * the user picked, so re-validate every value server-side rather than trusting it. Absurd
 * values are dropped (nulled out) rather than stored or used to reject the whole day, so one
 * bad sample doesn't cost the other metrics for that date.
 */
function sanitize(day: z.infer<typeof DaySchema>): NewMeasurement | null {
  const weightKg =
    day.weightKg !== null && (day.weightKg < 20 || day.weightKg > 400) ? null : day.weightKg;
  const bodyFatPct =
    day.bodyFatPct !== null && (day.bodyFatPct < 1 || day.bodyFatPct > 70) ? null : day.bodyFatPct;
  const leanBodyMassKg =
    day.leanBodyMassKg !== null && (day.leanBodyMassKg < 10 || day.leanBodyMassKg > 300)
      ? null
      : day.leanBodyMassKg;

  if (weightKg === null && bodyFatPct === null && leanBodyMassKg === null) return null;

  return {
    measuredAt: noonMadrid(day.day),
    source: "apple_health",
    weightKg: num(weightKg),
    bodyFatPct: num(bodyFatPct),
    fatFreeMassKg: num(leanBodyMassKg),
  };
}

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { days } = parsed.data;

  const rows = days.map(sanitize).filter((r): r is NewMeasurement => r !== null);

  // Idempotent re-import: the unique (measured_at, source) constraint means running the
  // same export twice just no-ops on the second pass instead of duplicating rows.
  const inserted = rows.length
    ? await db
        .insert(measurements)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: measurements.id })
    : [];

  return NextResponse.json({
    inserted: inserted.length,
    submitted: days.length,
    // Covers true duplicates (onConflictDoNothing) and days dropped entirely by sanitize()
    // (all metrics out of plausible range) — both simply didn't end up as a stored row.
    skippedAsDuplicate: days.length - inserted.length,
  });
}
