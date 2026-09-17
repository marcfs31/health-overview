import { NextResponse } from "next/server";
import { z } from "zod";
import { db, measurements, type NewMeasurement } from "@/lib/db";

export const runtime = "nodejs";

const CLINIC_TZ = "Europe/Madrid";

/**
 * Turns a naive "YYYY-MM-DDTHH:mm" wall-clock time into the correct UTC instant for
 * Europe/Madrid, independent of the server process's own timezone (dev runs in Madrid,
 * Vercel runs in UTC).
 *
 * This is a deliberate duplicate of the identically-named helper in the sibling
 * `../route.ts` (the InBody upload route): that file is owned by another workstream in
 * this task and is off limits to edit, and it does not export the helper, so the logic is
 * copied here rather than shared.
 */
function clinicTimeToDate(naive: string): Date {
  const isoish = naive.length === 16 ? `${naive}:00` : naive;
  const asUtc = new Date(`${isoish}Z`);
  if (Number.isNaN(asUtc.getTime())) throw new Error(`Fecha ilegible: ${naive}`);
  const inTz = new Date(asUtc.toLocaleString("en-US", { timeZone: CLINIC_TZ }));
  const inUtc = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(asUtc.getTime() - (inTz.getTime() - inUtc.getTime()));
}

/** Rejects strings like "2024-02-30" that `Date` parsing would silently roll over. */
function isValidCalendarDate(s: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return (
    asUtc.getUTCFullYear() === year && asUtc.getUTCMonth() === month - 1 && asUtc.getUTCDate() === day
  );
}

/** "Today" as a calendar date in Europe/Madrid, independent of the server process's own TZ. */
function todayInMadrid(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TZ }).format(new Date());
}

function fmtEs(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("es-ES", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// TRUST BOUNDARY: this is the only server-side validation of a manual weigh-in. Nothing
// upstream of this schema can be trusted — client-side <input min/max> is a convenience,
// not a guarantee.
const BodySchema = z
  .object({
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener el formato AAAA-MM-DD.")
      .refine(isValidCalendarDate, { message: "Esa fecha no existe en el calendario." })
      .refine((d) => d <= todayInMadrid(), { message: "La fecha no puede ser futura." }),
    weightKg: z
      .number()
      .min(20, "El peso debe estar entre 20 y 400 kg.")
      .max(400, "El peso debe estar entre 20 y 400 kg.")
      .optional(),
    bodyFatPct: z
      .number()
      .min(1, "El % de grasa corporal debe estar entre 1 y 70.")
      .max(70, "El % de grasa corporal debe estar entre 1 y 70.")
      .optional(),
    skeletalMuscleMassKg: z
      .number()
      .min(5, "La masa muscular debe estar entre 5 y 100 kg.")
      .max(100, "La masa muscular debe estar entre 5 y 100 kg.")
      .optional(),
    note: z.string().max(2000, "La nota es demasiado larga.").optional(),
  })
  .refine(
    (data) =>
      data.weightKg !== undefined || data.bodyFatPct !== undefined || data.skeletalMuscleMassKg !== undefined,
    {
      message: "Indica al menos un valor: peso, % de grasa corporal o masa muscular.",
      path: ["weightKg"],
    },
  );

const num = (v: number | undefined) => (v === undefined ? null : String(v));

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", issues: parsed.error.issues }, { status: 400 });
  }

  const { date, weightKg, bodyFatPct, skeletalMuscleMassKg, note } = parsed.data;
  const trimmedNote = note?.trim();

  // Noon keeps the calendar date stable across rendering timezones — matches
  // scripts/seed.ts and the existing InBody upload route.
  const values: NewMeasurement = {
    measuredAt: clinicTimeToDate(`${date}T12:00`),
    source: "manual_log",
    weightKg: num(weightKg),
    bodyFatPct: num(bodyFatPct),
    skeletalMuscleMassKg: num(skeletalMuscleMassKg),
    note: trimmedNote ? trimmedNote : null,
  };

  const inserted = await db.insert(measurements).values(values).onConflictDoNothing().returning({
    id: measurements.id,
  });

  // .onConflictDoNothing() succeeds even when the unique (measured_at, source) constraint
  // swallows the row — report that honestly instead of claiming success.
  if (inserted.length === 0) {
    return NextResponse.json(
      { error: `Ya existe una entrada de báscula para el ${fmtEs(date)}.` },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, id: inserted[0]!.id });
}
