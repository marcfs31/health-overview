import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db, measurements, type NewMeasurement } from "@/lib/db";

export const runtime = "nodejs";

/** Route params are async in Next 16 — see node_modules/next/dist/docs/.../route.md. */
type RouteContext = { params: Promise<{ id: string }> };

/** Accepts only a bare positive integer — no leading "+", no decimals, no whitespace. */
function parsePositiveId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Same bounds as POST /api/measurements/manual — this is the one other place a numeric
// measurement value can be written, so it is held to the same trust-boundary rules.
const PatchSchema = z
  .object({
    weightKg: z
      .number()
      .min(20, "El peso debe estar entre 20 y 400 kg.")
      .max(400, "El peso debe estar entre 20 y 400 kg.")
      .nullable()
      .optional(),
    bodyFatPct: z
      .number()
      .min(1, "El % de grasa corporal debe estar entre 1 y 70.")
      .max(70, "El % de grasa corporal debe estar entre 1 y 70.")
      .nullable()
      .optional(),
    skeletalMuscleMassKg: z
      .number()
      .min(5, "La masa muscular debe estar entre 5 y 100 kg.")
      .max(100, "La masa muscular debe estar entre 5 y 100 kg.")
      .nullable()
      .optional(),
    note: z.string().max(2000, "La nota es demasiado larga.").nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "No se ha indicado ningún campo para actualizar.",
  });

const numOrNull = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));

export async function DELETE(_request: Request, ctx: RouteContext) {
  const { id: rawId } = await ctx.params;
  const id = parsePositiveId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Id de medición inválido." }, { status: 400 });
  }

  const deleted = await db.delete(measurements).where(eq(measurements.id, id)).returning({
    id: measurements.id,
  });

  if (deleted.length === 0) {
    return NextResponse.json({ error: `No existe ninguna medición con id ${id}.` }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: deleted[0]!.id });
}

export async function PATCH(request: Request, ctx: RouteContext) {
  const { id: rawId } = await ctx.params;
  const id = parsePositiveId(rawId);
  if (id === null) {
    return NextResponse.json({ error: "Id de medición inválido." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }

  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos", issues: parsed.error.issues }, { status: 400 });
  }

  const data = parsed.data;
  const values: Partial<
    Pick<NewMeasurement, "weightKg" | "bodyFatPct" | "skeletalMuscleMassKg" | "note">
  > = {};
  if ("weightKg" in data) values.weightKg = numOrNull(data.weightKg);
  if ("bodyFatPct" in data) values.bodyFatPct = numOrNull(data.bodyFatPct);
  if ("skeletalMuscleMassKg" in data) values.skeletalMuscleMassKg = numOrNull(data.skeletalMuscleMassKg);
  if ("note" in data) {
    const note = data.note;
    values.note = note === null || note === undefined ? null : note.trim() || null;
  }

  const updated = await db.update(measurements).set(values).where(eq(measurements.id, id)).returning({
    id: measurements.id,
  });

  if (updated.length === 0) {
    return NextResponse.json({ error: `No existe ninguna medición con id ${id}.` }, { status: 404 });
  }

  return NextResponse.json({ ok: true, id: updated[0]!.id });
}
