import type { SegmentalAnalysis, SegmentSet } from "@/lib/db";

type SegmentKey = "leftArm" | "rightArm" | "trunk" | "leftLeg" | "rightLeg";

const SEGMENT_ORDER: SegmentKey[] = ["leftArm", "rightArm", "trunk", "leftLeg", "rightLeg"];

const SEGMENT_LABELS: Record<SegmentKey, string> = {
  leftArm: "Brazo izquierdo",
  rightArm: "Brazo derecho",
  trunk: "Tronco",
  leftLeg: "Pierna izquierda",
  rightLeg: "Pierna derecha",
};

/** Pulls one segment's value out of a (possibly absent) segment set, guarding every shape. */
function pick(set: SegmentSet | null | undefined, key: SegmentKey): number | null {
  if (!set) return null;
  const v = set[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtKg(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)} kg`;
}

function fmtPct(v: number | null): string {
  return v === null ? "" : ` (${v.toFixed(0)}%)`;
}

/**
 * InBody five-segment breakdown: lean and fat mass per limb/trunk.
 *
 * Every level of `segmental` may be missing — the whole object, one of the four
 * lean/fat/pct sub-objects, or a single segment's field — so every read goes through
 * `pick`, which only ever returns a finite number or null. Nothing here can produce NaN,
 * "undefined", or throw.
 */
export function SegmentalView({
  segmental,
  className,
}: {
  segmental: SegmentalAnalysis | null | undefined;
  className?: string;
}) {
  if (!segmental) {
    return (
      <p className={["text-xs text-ink-muted", className].filter(Boolean).join(" ")}>
        Sin datos segmentales para este registro.
      </p>
    );
  }

  const { leanKg, fatKg, leanPct, fatPct } = segmental;

  return (
    <div className={["", className].filter(Boolean).join(" ")}>
      <div className="mb-2 flex items-center gap-4 text-xs text-ink-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ background: "var(--series-lean)" }}
          />
          Masa magra
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ background: "var(--series-fat)" }}
          />
          Masa grasa
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {SEGMENT_ORDER.map((key) => {
          const lean = pick(leanKg, key);
          const fat = pick(fatKg, key);
          const leanP = pick(leanPct, key);
          const fatP = pick(fatPct, key);
          const total = (lean ?? 0) + (fat ?? 0);
          const leanWidth = total > 0 && lean !== null ? (lean / total) * 100 : 0;
          const fatWidth = total > 0 && fat !== null ? (fat / total) * 100 : 0;
          const hasBar = total > 0;

          return (
            <div key={key} className="rounded-lg border border-hairline bg-page p-3">
              <p className="text-xs font-medium text-ink-secondary">{SEGMENT_LABELS[key]}</p>

              <div className="mt-2 flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--series-lean)" }}>
                  {fmtKg(lean)}
                  <span className="ml-0.5 font-normal text-ink-muted">{fmtPct(leanP)}</span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-semibold tabular-nums" style={{ color: "var(--series-fat)" }}>
                  {fmtKg(fat)}
                  <span className="ml-0.5 font-normal text-ink-muted">{fmtPct(fatP)}</span>
                </span>
              </div>

              {hasBar ? (
                <div
                  className="mt-2 flex h-1.5 overflow-hidden rounded-full"
                  style={{ background: "var(--grid)" }}
                  role="img"
                  aria-label={`${SEGMENT_LABELS[key]}: ${fmtKg(lean)} magra, ${fmtKg(fat)} grasa`}
                >
                  <span style={{ width: `${leanWidth}%`, background: "var(--series-lean)" }} />
                  <span style={{ width: `${fatWidth}%`, background: "var(--series-fat)" }} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
