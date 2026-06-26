/**
 * LifecycleTimeline — the compact 5-node horizontal timeline on the build/spec card
 * ([[build-card-lifecycle-timeline]] Phase 2).
 *
 * Spec Review · Build · Spec Test · Security · Fold — one shared component for the roadmap-board
 * card AND the Control Tower / spec-detail card (the reusable-components rule). Each completed
 * upstream stage renders a check; the CURRENT stage attaches the live status pill (Building /
 * Queued / Needs attention / …) to its node so the pill lives where work is actually happening
 * instead of floating on the card.
 *
 * Pure + server-renderable: takes a Phase-1 LifecycleDerivation (`deriveLifecycleStage(ctx)`) and an
 * optional `currentLabel` override the parent computes from the live job status (e.g. "Building…",
 * "Queued · test", "Folding…"). Phone-first / compact — the board card is small.
 */
import type { LifecycleDerivation, LifecycleStageStatus } from "@/lib/build-lifecycle";

interface LifecycleTimelineProps {
  derivation: LifecycleDerivation;
  /** Override the default pill label on the current stage (e.g. "Building…" from the live job). */
  currentLabel?: string;
  /** Tooltip on the current stage's pill (rendered on hover). */
  currentTitle?: string;
  /** "card" (default) = on a board / detail card; "compact" = a denser variant (smaller dot, tighter gaps). */
  density?: "card" | "compact";
}

const DEFAULT_PILL_LABEL: Record<LifecycleStageStatus, string> = {
  pending: "pending",
  active: "active",
  done: "done",
  "needs-attention": "needs attention",
};

const NODE_RING: Record<LifecycleStageStatus, string> = {
  pending: "border-zinc-200 bg-white text-zinc-300 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-600",
  active: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  done: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  "needs-attention": "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
};

const PILL_CHIP: Record<LifecycleStageStatus, string> = {
  pending: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  active: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  "needs-attention": "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
};

const CONNECTOR_COLOR: Record<LifecycleStageStatus, string> = {
  pending: "bg-zinc-200 dark:bg-zinc-800",
  active: "bg-zinc-200 dark:bg-zinc-800",
  done: "bg-emerald-300 dark:bg-emerald-700",
  "needs-attention": "bg-zinc-200 dark:bg-zinc-800",
};

/** Single-character node glyph — a check on done, a tiny dot otherwise (no emoji for color-blind safety). */
function nodeGlyph(status: LifecycleStageStatus): string {
  if (status === "done") return "✓"; // ✓
  if (status === "needs-attention") return "!";
  if (status === "active") return "•"; // •
  return "·"; // · (faint center dot for pending)
}

export default function LifecycleTimeline({ derivation, currentLabel, currentTitle, density = "card" }: LifecycleTimelineProps) {
  const { stages, current } = derivation;
  const dot = density === "compact" ? "h-4 w-4 text-[10px]" : "h-5 w-5 text-[11px]";
  const labelText = density === "compact" ? "text-[9px]" : "text-[10px]";
  return (
    <div className="mt-2 w-full">
      <div className="flex w-full items-start justify-between gap-1">
        {stages.map((stage, idx) => {
          const isCurrent = stage.name === current;
          const next = stages[idx + 1];
          const connectorStatus: LifecycleStageStatus = stage.status === "done" ? "done" : "pending";
          const ariaLabel = `${stage.label}: ${stage.status}`;
          return (
            <div key={stage.name} className="flex min-w-0 flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                {/* The node circle, centered above its label. */}
                <div className="flex flex-1 items-center">
                  <span className="h-px flex-1" aria-hidden />
                  <span
                    aria-label={ariaLabel}
                    title={stage.label}
                    className={`flex ${dot} flex-shrink-0 items-center justify-center rounded-full border font-bold leading-none ${NODE_RING[stage.status]}`}
                  >
                    {nodeGlyph(stage.status)}
                  </span>
                  <span
                    className={`h-px flex-1 ${next ? CONNECTOR_COLOR[connectorStatus] : "bg-transparent"}`}
                    aria-hidden
                  />
                </div>
              </div>
              <span
                className={`mt-1 block w-full truncate text-center font-medium ${labelText} ${
                  isCurrent ? "text-zinc-700 dark:text-zinc-200" : "text-zinc-400 dark:text-zinc-500"
                }`}
                title={stage.label}
              >
                {stage.label}
              </span>
              {/* The CURRENT stage attaches its live status pill directly below its label — replacing the
                  floating pill that used to live in the card's action row. Only one pill on a card. A done
                  current stage (a folded spec — current = fold, status = done) shows no pill (all checked). */}
              {isCurrent && stage.status !== "done" && (
                <span
                  title={currentTitle ?? `${stage.label} — ${stage.status}`}
                  className={`mt-1 inline-flex max-w-full items-center truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium ${PILL_CHIP[stage.status]}`}
                >
                  {currentLabel ?? DEFAULT_PILL_LABEL[stage.status]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
