import { NextResponse } from "next/server";
import { z } from "zod";
import { db, measurements, rawFiles, type NewMeasurement } from "@/lib/db";
import { ExtractionSchema } from "@/lib/extract";

export const runtime = "nodejs";

const BodySchema = z.object({
  data: ExtractionSchema,
  filename: z.string().nullable().optional(),
  extractionMethod: z.string().nullable().optional(),
  sizeBytes: z.number().nullable().optional(),
});

const CLINIC_TZ = "Europe/Madrid";

/**
 * Report timestamps are wall-clock times at the clinic with no offset. The dev machine
 * runs in Madrid and Vercel runs in UTC, so parsing them naively would shift every scan
 * by an hour or two in production only.
 */
function clinicTimeToDate(naive: string): Date {
  const isoish = naive.length === 16 ? `${naive}:00` : naive;
  const asUtc = new Date(`${isoish}Z`);
  if (Number.isNaN(asUtc.getTime())) throw new Error(`Fecha ilegible: ${naive}`);
  const inTz = new Date(asUtc.toLocaleString("en-US", { timeZone: CLINIC_TZ }));
  const inUtc = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(asUtc.getTime() - (inTz.getTime() - inUtc.getTime()));
}

const num = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));

export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Datos inválidos", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { data, filename, extractionMethod, sizeBytes } = parsed.data;

  let rawFileId: number | null = null;
  if (filename) {
    const [row] = await db
      .insert(rawFiles)
      .values({
        filename,
        extractionMethod: extractionMethod ?? null,
        sizeBytes: sizeBytes ?? null,
        extractionRaw: data,
      })
      .returning({ id: rawFiles.id });
    rawFileId = row.id;
  }

  const main: NewMeasurement = {
    measuredAt: clinicTimeToDate(data.measuredAt),
    source: "inbody",
    weightKg: num(data.weightKg),
    bodyFatPct: num(data.bodyFatPct),
    skeletalMuscleMassKg: num(data.skeletalMuscleMassKg),
    bmi: num(data.bmi),
    bodyFatMassKg: num(data.bodyFatMassKg),
    fatFreeMassKg: num(data.fatFreeMassKg),
    totalBodyWaterL: num(data.totalBodyWaterL),
    proteinKg: num(data.proteinKg),
    mineralsKg: num(data.mineralsKg),
    bmrKcal: data.bmrKcal ?? null,
    waistHipRatio: num(data.waistHipRatio),
    visceralFatLevel: data.visceralFatLevel ?? null,
    segmental: data.segmental ?? null,
    note: data.notes ?? null,
    rawFileId,
  };

  // Prior scans printed on the report are real measurements too — inserting them is how
  // a single upload backfills scans whose own PDF was never kept.
  const backfill: NewMeasurement[] = data.history.map((h) => ({
    measuredAt: clinicTimeToDate(h.measuredAt),
    source: "inbody",
    weightKg: num(h.weightKg),
    bodyFatPct: num(h.bodyFatPct),
    skeletalMuscleMassKg: num(h.skeletalMuscleMassKg),
    rawFileId,
  }));

  const inserted = await db
    .insert(measurements)
    .values([main, ...backfill])
    .onConflictDoNothing()
    .returning({ id: measurements.id, measuredAt: measurements.measuredAt });

  return NextResponse.json({
    inserted: inserted.length,
    submitted: 1 + backfill.length,
    skippedAsDuplicate: 1 + backfill.length - inserted.length,
  });
}
