/**
 * Seeds the historical record: manual weigh-ins + InBody scans.
 * Run with TZ=Europe/Madrid so naive clinic timestamps resolve to the right instant.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
// Node's type-stripping loader uses plain ESM resolution, so scripts import the
// schema directly with its extension rather than the app's bundler-style barrel.
import { measurements, type NewMeasurement } from "../src/lib/db/schema.ts";

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
const db = drizzle(client);

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data");

type WeightLogRow = {
  date: string;
  weight_kg: number;
  note: string | null;
  source: string;
};

type InBodyHistoryRow = {
  date: string;
  weight_kg: number;
  skeletal_muscle_mass_kg: number;
  body_fat_pct: number;
};

type FullReport = {
  bmi: number;
  body_fat_mass_kg: number;
  total_body_water_l: number;
  protein_kg: number;
  minerals_kg: number;
  fat_free_mass_kg: number;
  bmr_kcal: number;
  waist_hip_ratio: number;
  visceral_fat_level: number;
  segmental?: NonNullable<NewMeasurement["segmental"]>;
};

const weightLog: WeightLogRow[] = JSON.parse(
  readFileSync(join(dataDir, "weight-log.json"), "utf8"),
);
const inbody: { history: InBodyHistoryRow[]; full_reports: Record<string, FullReport> } =
  JSON.parse(readFileSync(join(dataDir, "inbody-history.json"), "utf8"));

const num = (v: number | undefined) => (v === undefined ? null : String(v));

// Manual log entries carry a date but no time. Noon keeps the calendar date stable
// in every rendering timezone instead of silently shifting a day.
const manualRows: NewMeasurement[] = weightLog.map((r) => ({
  measuredAt: new Date(`${r.date}T12:00:00`),
  source: "manual_log",
  weightKg: num(r.weight_kg),
  note: r.note,
}));

const inbodyRows: NewMeasurement[] = inbody.history.map((h) => {
  const day = h.date.slice(0, 10);
  const full = inbody.full_reports[day];
  return {
    measuredAt: new Date(`${h.date}:00`),
    source: "inbody",
    weightKg: num(h.weight_kg),
    bodyFatPct: num(h.body_fat_pct),
    skeletalMuscleMassKg: num(h.skeletal_muscle_mass_kg),
    bmi: num(full?.bmi),
    bodyFatMassKg: num(full?.body_fat_mass_kg),
    fatFreeMassKg: num(full?.fat_free_mass_kg),
    totalBodyWaterL: num(full?.total_body_water_l),
    proteinKg: num(full?.protein_kg),
    mineralsKg: num(full?.minerals_kg),
    bmrKcal: full?.bmr_kcal ?? null,
    waistHipRatio: num(full?.waist_hip_ratio),
    visceralFatLevel: full?.visceral_fat_level ?? null,
    segmental: full?.segmental ?? null,
  };
});

const rows = [...manualRows, ...inbodyRows];

const inserted = await db
  .insert(measurements)
  .values(rows)
  .onConflictDoNothing()
  .returning({ id: measurements.id });

console.log(
  `seeded: ${inserted.length} new rows (${manualRows.length} manual + ${inbodyRows.length} inbody submitted)`,
);
await client.end();
