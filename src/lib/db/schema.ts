import {
  pgTable,
  serial,
  text,
  timestamp,
  numeric,
  integer,
  jsonb,
  unique,
  index,
} from "drizzle-orm/pg-core";

export const rawFiles = pgTable("raw_files", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  blobUrl: text("blob_url"),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  extractionMethod: text("extraction_method"),
  extractionRaw: jsonb("extraction_raw"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
});

export const measurements = pgTable(
  "measurements",
  {
    id: serial("id").primaryKey(),
    measuredAt: timestamp("measured_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),

    weightKg: numeric("weight_kg", { precision: 5, scale: 2 }),
    bodyFatPct: numeric("body_fat_pct", { precision: 4, scale: 1 }),
    skeletalMuscleMassKg: numeric("skeletal_muscle_mass_kg", { precision: 4, scale: 1 }),

    bmi: numeric("bmi", { precision: 4, scale: 1 }),
    bodyFatMassKg: numeric("body_fat_mass_kg", { precision: 5, scale: 2 }),
    fatFreeMassKg: numeric("fat_free_mass_kg", { precision: 5, scale: 2 }),
    totalBodyWaterL: numeric("total_body_water_l", { precision: 4, scale: 1 }),
    proteinKg: numeric("protein_kg", { precision: 4, scale: 1 }),
    mineralsKg: numeric("minerals_kg", { precision: 4, scale: 2 }),
    bmrKcal: integer("bmr_kcal"),
    waistHipRatio: numeric("waist_hip_ratio", { precision: 3, scale: 2 }),
    visceralFatLevel: integer("visceral_fat_level"),

    segmental: jsonb("segmental").$type<SegmentalAnalysis | null>(),

    note: text("note"),
    rawFileId: integer("raw_file_id").references(() => rawFiles.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("measurements_at_source_unique").on(t.measuredAt, t.source),
    index("measurements_measured_at_idx").on(t.measuredAt),
  ],
);

export type SegmentSet = {
  leftArm?: number | null;
  rightArm?: number | null;
  trunk?: number | null;
  leftLeg?: number | null;
  rightLeg?: number | null;
};

export type SegmentalAnalysis = {
  leanKg?: SegmentSet | null;
  leanPct?: SegmentSet | null;
  fatKg?: SegmentSet | null;
  fatPct?: SegmentSet | null;
};

export type Measurement = typeof measurements.$inferSelect;
export type NewMeasurement = typeof measurements.$inferInsert;
export type RawFile = typeof rawFiles.$inferSelect;
