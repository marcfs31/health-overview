"use client";

import Link from "next/link";
import { useRef, useState } from "react";

type Extraction = {
  measuredAt: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  skeletalMuscleMassKg: number | null;
  bmi: number | null;
  bodyFatMassKg: number | null;
  fatFreeMassKg: number | null;
  totalBodyWaterL: number | null;
  proteinKg: number | null;
  mineralsKg: number | null;
  bmrKcal: number | null;
  waistHipRatio: number | null;
  visceralFatLevel: number | null;
  segmental: unknown;
  history: {
    measuredAt: string;
    weightKg: number | null;
    skeletalMuscleMassKg: number | null;
    bodyFatPct: number | null;
  }[];
  confidence: "high" | "medium" | "low";
  notes: string | null;
};

type ExtractResponse = {
  data: Extraction;
  method: string;
  filename: string;
  sizeBytes: number;
  error?: string;
};

type Stage =
  | { name: "idle" }
  | { name: "extracting" }
  | { name: "review"; data: Extraction; method: string; filename: string; sizeBytes: number }
  | { name: "saving" }
  | { name: "saved"; inserted: number; skipped: number }
  | { name: "error"; message: string };

// Vercel rejects request bodies over 4.5 MB; leave headroom for multipart overhead.
const MAX_PDF_BYTES = 4_000_000;
const MAX_EDGE = 2000;
const JPEG_QUALITY = 0.88;

/**
 * Phones produce 4-12 MP HEIC/JPEG files. Vercel rejects request bodies over 4.5 MB, and
 * the API does not accept HEIC at all — so images are re-encoded to a bounded JPEG in the
 * browser, which fixes both. The canvas decode also handles HEIC on iOS.
 */
async function normaliseImage(file: File): Promise<File> {
  if (file.type === "application/pdf") return file;

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY),
  );
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
}

const FIELDS: { key: keyof Extraction; label: string; unit: string }[] = [
  { key: "weightKg", label: "Peso", unit: "kg" },
  { key: "bodyFatPct", label: "Grasa corporal", unit: "%" },
  { key: "skeletalMuscleMassKg", label: "Masa musculoesquelética", unit: "kg" },
  { key: "bodyFatMassKg", label: "Masa grasa", unit: "kg" },
  { key: "fatFreeMassKg", label: "Masa libre de grasa", unit: "kg" },
  { key: "bmi", label: "IMC", unit: "" },
  { key: "totalBodyWaterL", label: "Agua corporal total", unit: "L" },
  { key: "proteinKg", label: "Proteínas", unit: "kg" },
  { key: "mineralsKg", label: "Minerales", unit: "kg" },
  { key: "bmrKcal", label: "Metabolismo basal", unit: "kcal" },
  { key: "waistHipRatio", label: "Cintura-cadera", unit: "" },
  { key: "visceralFatLevel", label: "Grasa visceral", unit: "nivel" },
];

export default function UploadPage() {
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    // A PDF cannot be re-encoded in the browser the way a photo can, so an oversized one
    // is rejected up front. Vercel refuses request bodies over 4.5 MB at the platform
    // level, before the route handler runs — without this guard a large report would
    // upload fine in dev and fail only in production.
    if (file.type === "application/pdf" && file.size > MAX_PDF_BYTES) {
      setStage({
        name: "error",
        message: `El PDF pesa ${(file.size / 1_048_576).toFixed(1)} MB y el límite es 4 MB. Haz una foto del informe: se reduce automáticamente antes de subirla.`,
      });
      return;
    }

    setStage({ name: "extracting" });
    try {
      const normalised = await normaliseImage(file);
      const body = new FormData();
      body.append("file", normalised);
      const res = await fetch("/api/extract", { method: "POST", body });

      // A platform-level rejection (413, gateway error) returns HTML, not JSON — parsing
      // it blindly would throw and surface a raw JS error instead of a readable message.
      const raw = await res.text();
      let json: Partial<ExtractResponse> = {};
      try {
        json = JSON.parse(raw) as Partial<ExtractResponse>;
      } catch {
        setStage({
          name: "error",
          message:
            res.status === 413
              ? "El fichero es demasiado grande para el servidor. Sube una foto del informe."
              : `El servidor respondió con un error (${res.status}).`,
        });
        return;
      }

      if (!res.ok) {
        setStage({ name: "error", message: json.error ?? "Fallo en la extracción." });
        return;
      }
      if (!json.data) {
        setStage({ name: "error", message: "La respuesta del servidor no contenía datos." });
        return;
      }
      setStage({
        name: "review",
        data: json.data,
        method: json.method ?? "desconocido",
        filename: json.filename ?? "informe",
        sizeBytes: json.sizeBytes ?? 0,
      });
    } catch (e) {
      setStage({ name: "error", message: e instanceof Error ? e.message : "Error inesperado." });
    }
  }

  async function save(current: Extract<Stage, { name: "review" }>) {
    setStage({ name: "saving" });
    const res = await fetch("/api/measurements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        data: current.data,
        filename: current.filename,
        extractionMethod: current.method,
        sizeBytes: current.sizeBytes,
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setStage({ name: "error", message: json.error ?? "No se pudo guardar." });
      return;
    }
    setStage({ name: "saved", inserted: json.inserted, skipped: json.skippedAsDuplicate });
  }

  function updateField(key: string, raw: string) {
    setStage((s) => {
      if (s.name !== "review") return s;
      const value = raw.trim() === "" ? null : Number(raw.replace(",", "."));
      return { ...s, data: { ...s.data, [key]: Number.isFinite(value) ? value : null } };
    });
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6">
        <Link href="/" className="text-sm text-ink-secondary hover:underline">
          ← Volver
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">Subir informe</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          PDF o foto de un informe InBody. Se leen los valores automáticamente — incluidas las
          mediciones anteriores del gráfico inferior — y los revisas antes de guardar.
        </p>
      </header>

      {(stage.name === "idle" || stage.name === "error") && (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-xl border border-dashed border-hairline bg-surface px-6 py-12 text-center transition hover:border-weight"
          >
            <p className="text-base font-medium text-ink">Elegir PDF o foto</p>
            <p className="mt-1 text-xs text-ink-secondary">PDF, JPEG, PNG o WebP</p>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
        </>
      )}

      {stage.name === "extracting" && (
        <p className="rounded-xl border border-hairline bg-surface p-6 text-sm text-ink-secondary">
          Leyendo el informe…
        </p>
      )}

      {stage.name === "error" && (
        <p
          className="mt-4 rounded-xl border p-4 text-sm"
          style={{ borderColor: "var(--status-critical)", color: "var(--status-critical)" }}
        >
          {stage.message}
        </p>
      )}

      {stage.name === "review" && (
        <div className="rounded-xl border border-hairline bg-surface p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-base font-semibold text-ink">Revisa antes de guardar</h2>
            <span className="text-xs text-ink-muted">
              {stage.method === "pdf_text" ? "capa de texto del PDF" : "lectura visual"} · confianza{" "}
              {stage.data.confidence}
            </span>
          </div>

          <label className="mb-4 block">
            <span className="mb-1 block text-xs font-medium text-ink-secondary">Fecha y hora</span>
            <input
              type="text"
              value={stage.data.measuredAt}
              onChange={(e) =>
                setStage((s) =>
                  s.name === "review"
                    ? { ...s, data: { ...s.data, measuredAt: e.target.value } }
                    : s,
                )
              }
              className="w-full rounded-lg border border-hairline bg-page px-3 py-2 text-sm text-ink"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={String(f.key)} className="block">
                <span className="mb-1 block text-xs font-medium text-ink-secondary">
                  {f.label} {f.unit && <span className="text-ink-muted">({f.unit})</span>}
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={(stage.data[f.key] as number | null) ?? ""}
                  placeholder="—"
                  onChange={(e) => updateField(String(f.key), e.target.value)}
                  className="w-full rounded-lg border border-hairline bg-page px-3 py-2 text-sm tabular-nums text-ink"
                />
              </label>
            ))}
          </div>

          {stage.data.history.length > 0 && (
            <div className="mt-5 rounded-lg border border-hairline p-3">
              <p className="text-sm font-medium text-ink">
                + {stage.data.history.length} mediciones anteriores del gráfico
              </p>
              <p className="mt-0.5 mb-2 text-xs text-ink-secondary">
                Se guardarán también. Las que ya existan se ignoran.
              </p>
              <ul className="space-y-1 text-xs text-ink-secondary">
                {stage.data.history.map((h) => (
                  <li key={h.measuredAt} className="tabular-nums">
                    {h.measuredAt.slice(0, 10)} · {h.weightKg ?? "—"} kg · {h.bodyFatPct ?? "—"}%
                    grasa
                  </li>
                ))}
              </ul>
            </div>
          )}

          {stage.data.notes && (
            <p className="mt-4 text-xs text-ink-muted">Notas del lector: {stage.data.notes}</p>
          )}

          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => save(stage)}
              className="rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ background: "var(--series-weight)" }}
            >
              Guardar
            </button>
            <button
              type="button"
              onClick={() => setStage({ name: "idle" })}
              className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink-secondary"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {stage.name === "saving" && (
        <p className="rounded-xl border border-hairline bg-surface p-6 text-sm text-ink-secondary">
          Guardando…
        </p>
      )}

      {stage.name === "saved" && (
        <div className="rounded-xl border border-hairline bg-surface p-6">
          <p className="text-base font-medium text-ink">
            Guardadas {stage.inserted} mediciones
            {stage.skipped > 0 && ` (${stage.skipped} ya existían)`}
          </p>
          <div className="mt-4 flex gap-2">
            <Link
              href="/"
              className="rounded-lg px-4 py-2 text-sm font-medium text-white"
              style={{ background: "var(--series-weight)" }}
            >
              Ver el panel
            </Link>
            <button
              type="button"
              onClick={() => setStage({ name: "idle" })}
              className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink-secondary"
            >
              Subir otro
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
