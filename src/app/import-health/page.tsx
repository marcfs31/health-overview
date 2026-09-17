"use client";

import Link from "next/link";
import { useRef, useState } from "react";

const MADRID_TZ = "Europe/Madrid";
const BATCH_SIZE = 500; // Vercel caps request bodies at 4.5 MB; 500 days of 4 numbers is well under that.

type MetricKey = "weightKg" | "bodyFatPct" | "leanBodyMassKg";

// Apple Health export.xml stores every quantity sample as a single self-closing
// <Record .../> element with no nested children — see the three identifiers below.
// There are ~30 other HKQuantityTypeIdentifier* types (steps, heart rate, energy...)
// mixed into the same file; everything that isn't one of these three is ignored.
const TYPE_MAP: Record<string, MetricKey> = {
  HKQuantityTypeIdentifierBodyMass: "weightKg",
  HKQuantityTypeIdentifierBodyFatPercentage: "bodyFatPct",
  HKQuantityTypeIdentifierLeanBodyMass: "leanBodyMassKg",
};

// Precompiled once — this runs against every <Record> tag in a file that can hold
// tens of millions of them, so a fresh RegExp per call would add up fast.
const TYPE_RE = /\btype="([^"]*)"/;
const START_DATE_RE = /\bstartDate="([^"]*)"/;
const VALUE_RE = /\bvalue="([^"]*)"/;
const UNIT_RE = /\bunit="([^"]*)"/;

const DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: MADRID_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type DayAggregate = {
  weightKg: number | null;
  bodyFatPct: number | null;
  leanBodyMassKg: number | null;
};

type Day = { day: string } & DayAggregate;

type ParseProgress = { bytesProcessed: number; totalBytes: number; recordsMatched: number };
type UploadProgress = {
  batchesDone: number;
  totalBatches: number;
  inserted: number;
  skippedAsDuplicate: number;
};

type Stage =
  | { name: "idle" }
  | { name: "zip-warning" }
  | { name: "parsing"; fileName: string; progress: ParseProgress }
  | { name: "uploading"; totalDays: number; progress: UploadProgress }
  | { name: "done"; daysFound: number; inserted: number; skippedAsDuplicate: number }
  | { name: "error"; message: string };

/** Apple's export date format is "YYYY-MM-DD HH:MM:SS ±HHMM"; convert to a parseable ISO string. */
function parseAppleDate(raw: string): Date | null {
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeValue(metric: MetricKey, rawValue: string, unit: string | null): number | null {
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return null;

  if (metric === "bodyFatPct") {
    // HealthKit's internal HKUnit.percent() is a 0-1 fraction, but different sources write
    // export.xml differently: some as 0-1 (0.171), some as 0-100 (17.1). Our DB stores an
    // actual percentage number (existing inbody rows read e.g. 17.1, not 0.171), so — unlike
    // a generic HealthKit consumer that would normalize DOWN to 0-1 — we normalize UP to 0-100.
    return n <= 1 ? n * 100 : n;
  }

  // weightKg and leanBodyMassKg: HealthKit reports mass in whatever unit the phone's Health
  // settings use. Convert lb -> kg defensively; anything else (kg, or missing/unknown unit) is
  // taken as-is since kg is by far the common case for an es-ES account.
  if (unit === "lb" || unit === "lbs") return n * 0.45359237;
  return n;
}

function attr(tag: string, re: RegExp): string | null {
  const m = re.exec(tag);
  return m ? m[1] : null;
}

/**
 * Streams export.xml chunk by chunk (never loads the whole file into memory — it can be
 * hundreds of MB to multiple GB) and pulls out only body-mass / body-fat / lean-mass
 * <Record> tags, aggregating to one value per calendar day per metric.
 *
 * Aggregation choice: a smart scale can log many readings a day. We keep the EARLIEST
 * reading of each day per metric (a morning weigh-in is the most comparable day to day),
 * tracked independently per metric so a day with only a partial reading isn't dropped.
 * "Calendar day" is decided in Europe/Madrid regardless of the machine's own timezone.
 */
async function parseAppleHealthExport(
  file: File,
  onProgress: (p: ParseProgress) => void,
): Promise<Day[]> {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();

  // Per metric, the earliest (day, value) pair seen so far, keyed by calendar day.
  const byDay = new Map<string, { weightKg?: number; bodyFatPct?: number; leanBodyMassKg?: number }>();
  const earliestAt = new Map<string, number>(); // `${day}:${metric}` -> timestamp of the current winner

  let buffer = "";
  let bytesProcessed = 0;
  let recordsMatched = 0;

  const processTag = (tag: string) => {
    const type = attr(tag, TYPE_RE);
    if (!type) return;
    const metric = TYPE_MAP[type];
    if (!metric) return; // steps, heart rate, workouts, etc. — out of scope

    recordsMatched++;

    const startDateRaw = attr(tag, START_DATE_RE);
    const valueRaw = attr(tag, VALUE_RE);
    if (!startDateRaw || valueRaw === null) return;

    const date = parseAppleDate(startDateRaw);
    if (!date) return;

    const value = normalizeValue(metric, valueRaw, attr(tag, UNIT_RE));
    if (value === null) return;

    const day = DAY_FORMATTER.format(date);
    const key = `${day}:${metric}`;
    const at = date.getTime();
    const currentBest = earliestAt.get(key);
    if (currentBest !== undefined && at >= currentBest) return; // already have an earlier one

    earliestAt.set(key, at);
    const entry = byDay.get(day) ?? {};
    entry[metric] = value;
    byDay.set(day, entry);
  };

  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;

    buffer += chunk;
    // The XML export is effectively ASCII, so UTF-16 string length is a close enough proxy
    // for bytes read — good enough for a progress bar, not used for anything else.
    bytesProcessed += chunk.length;

    // Scan the buffer for complete <Record ...> tags, carrying any tag split across this
    // chunk boundary (or the boundary itself, mid "<Record") forward via `pos`.
    let pos = 0;
    while (true) {
      const tagStart = buffer.indexOf("<Record", pos);
      if (tagStart === -1) {
        // Keep a short tail so a "<Record" marker split across chunks isn't lost.
        pos = Math.max(pos, buffer.length - 8);
        break;
      }
      const gt = buffer.indexOf(">", tagStart);
      if (gt === -1) {
        pos = tagStart; // tag itself split across chunks — wait for more data
        break;
      }
      processTag(buffer.slice(tagStart, gt + 1));
      pos = gt + 1;
    }
    buffer = buffer.slice(pos);

    onProgress({ bytesProcessed, totalBytes: file.size, recordsMatched });
    // Yield to the event loop so React can flush the progress update and the tab stays responsive.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return Array.from(byDay.entries())
    .map(([day, m]) => ({
      day,
      weightKg: m.weightKg ?? null,
      bodyFatPct: m.bodyFatPct ?? null,
      leanBodyMassKg: m.leanBodyMassKg ?? null,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

async function uploadDays(
  days: Day[],
  onProgress: (p: UploadProgress) => void,
): Promise<{ inserted: number; submitted: number; skippedAsDuplicate: number }> {
  const batches: Day[][] = [];
  for (let i = 0; i < days.length; i += BATCH_SIZE) batches.push(days.slice(i, i + BATCH_SIZE));

  let inserted = 0;
  let skippedAsDuplicate = 0;
  let submitted = 0;

  for (let i = 0; i < batches.length; i++) {
    const res = await fetch("/api/health-import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: batches[i] }),
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error ?? "No se pudo guardar el lote.");
    }
    inserted += json.inserted;
    skippedAsDuplicate += json.skippedAsDuplicate;
    submitted += json.submitted;
    onProgress({
      batchesDone: i + 1,
      totalBatches: batches.length,
      inserted,
      skippedAsDuplicate,
    });
  }

  return { inserted, submitted, skippedAsDuplicate };
}

function formatMB(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function ExportInstructions() {
  return (
    <div className="mt-4 rounded-lg border border-hairline p-3">
      <p className="text-xs font-medium text-ink-secondary">Cómo exportar desde el iPhone</p>
      <p className="mt-1 text-xs text-ink-muted">
        Abre la app Salud → toca tu foto de perfil (arriba a la derecha) → &quot;Exportar todos
        los datos de salud&quot;. Se genera un archivo export.zip; descomprímelo y elige el
        export.xml que contiene.
      </p>
    </div>
  );
}

export default function ImportHealthPage() {
  const [stage, setStage] = useState<Stage>({ name: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (file.name.toLowerCase().endsWith(".zip")) {
      setStage({ name: "zip-warning" });
      return;
    }

    setStage({
      name: "parsing",
      fileName: file.name,
      progress: { bytesProcessed: 0, totalBytes: file.size, recordsMatched: 0 },
    });

    try {
      const days = await parseAppleHealthExport(file, (progress) => {
        setStage((s) => (s.name === "parsing" ? { ...s, progress } : s));
      });

      if (days.length === 0) {
        setStage({
          name: "error",
          message:
            "No se encontró ningún registro de peso, grasa corporal o masa magra en el archivo.",
        });
        return;
      }

      setStage({
        name: "uploading",
        totalDays: days.length,
        progress: { batchesDone: 0, totalBatches: Math.ceil(days.length / BATCH_SIZE), inserted: 0, skippedAsDuplicate: 0 },
      });

      const result = await uploadDays(days, (progress) => {
        setStage((s) => (s.name === "uploading" ? { ...s, progress } : s));
      });

      setStage({
        name: "done",
        daysFound: days.length,
        inserted: result.inserted,
        skippedAsDuplicate: result.skippedAsDuplicate,
      });
    } catch (e) {
      setStage({
        name: "error",
        message: e instanceof Error ? e.message : "Error inesperado al procesar el archivo.",
      });
    }
  }

  function reset() {
    setStage({ name: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  const parsePct =
    stage.name === "parsing" && stage.progress.totalBytes > 0
      ? Math.min(100, Math.round((stage.progress.bytesProcessed / stage.progress.totalBytes) * 100))
      : 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6">
        <Link href="/" className="text-sm text-ink-secondary hover:underline">
          ← Volver
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-ink">Importar Apple Salud</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Importa peso, grasa corporal y masa magra desde un export.xml de la app Salud. Se
          procesa en el navegador — el archivo no se sube entero, solo un resumen diario.
        </p>
      </header>

      {(stage.name === "idle" || stage.name === "zip-warning" || stage.name === "error") && (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-xl border border-dashed border-hairline bg-surface px-6 py-12 text-center transition hover:border-weight"
          >
            <p className="text-base font-medium text-ink">Elegir export.xml</p>
            <p className="mt-1 text-xs text-ink-secondary">Archivo .xml del export de Salud</p>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".xml,.zip,text/xml,application/xml,application/zip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <ExportInstructions />
        </>
      )}

      {stage.name === "zip-warning" && (
        <p
          className="mt-4 rounded-xl border p-4 text-sm"
          style={{ borderColor: "var(--status-warning)", color: "var(--status-warning)" }}
        >
          Ese es el archivo comprimido (export.zip). Descomprímelo primero y elige el
          export.xml que hay dentro — esta página no descomprime archivos.
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

      {stage.name === "parsing" && (
        <div className="rounded-xl border border-hairline bg-surface p-4 sm:p-5">
          <p className="text-sm font-medium text-ink">Analizando {stage.fileName}…</p>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-page">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${parsePct}%`, background: "var(--series-weight)" }}
            />
          </div>
          <p className="mt-2 text-xs tabular-nums text-ink-secondary">
            {formatMB(stage.progress.bytesProcessed)} MB / {formatMB(stage.progress.totalBytes)} MB
            {" · "}
            {stage.progress.recordsMatched} registros encontrados
          </p>
        </div>
      )}

      {stage.name === "uploading" && (
        <div className="rounded-xl border border-hairline bg-surface p-4 sm:p-5">
          <p className="text-sm font-medium text-ink">
            Guardando {stage.totalDays} días ({stage.progress.batchesDone}/{stage.progress.totalBatches}{" "}
            lotes)…
          </p>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-page">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${stage.progress.totalBatches > 0 ? (stage.progress.batchesDone / stage.progress.totalBatches) * 100 : 0}%`,
                background: "var(--series-weight)",
              }}
            />
          </div>
          <p className="mt-2 text-xs tabular-nums text-ink-secondary">
            insertados {stage.progress.inserted} · ya existían {stage.progress.skippedAsDuplicate}
          </p>
        </div>
      )}

      {stage.name === "done" && (
        <div className="rounded-xl border border-hairline bg-surface p-6">
          <p className="text-base font-medium text-ink">
            {stage.daysFound} días encontrados · {stage.inserted} guardados
            {stage.skippedAsDuplicate > 0 && ` · ${stage.skippedAsDuplicate} ya existían`}
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
              onClick={reset}
              className="rounded-lg border border-hairline px-4 py-2 text-sm text-ink-secondary"
            >
              Importar otro archivo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
