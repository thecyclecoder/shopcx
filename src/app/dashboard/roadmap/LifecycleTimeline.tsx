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
 *
 * [[spec-detail-timecard-timeline]] Phase 1 — optional `timecard` + `thresholds` props layer a
 * per-stage duration label under each node's label and a small inter-stage gap pill colored by
 * SLA breach (zinc under, amber over, rose over 2×). When the props are omitted the component
 * renders exactly as before (backward-compat for the board card + folded chip).
 */
import type { LifecycleDerivation, LifecycleStageName, LifecycleStageStatus } from "@/lib/build-lifecycle";
import type { MarioThreshold } from "@/lib/mario";
import type { TimecardStep, TimecardView } from "@/lib/spec-timecards";
import RunningTimer from "./RunningTimer";
import WaitTimer from "./WaitTimer";

/**
 * The M5 open-wait row resolved server-side in [slug]/page.tsx before render — the
 * `waiting_on_display` is the friendly label ("CEO", the owner's display_name from
 * `workspace_members`, the blocking spec's title, or "Max usage cap"), NEVER the raw slug or
 * UUID. `entered_at` anchors the {@link WaitTimer} client island. `sla_ms` colors the row
 * (sky under SLA, amber over, rose over 2×) at initial SSR — a subsequent tick past a
 * threshold does NOT re-color mid-session (a page refresh does).
 */
export interface WaitDisplay {
  wait_kind: string;
  /** Server-resolved friendly label — never a raw slug / UUID. */
  waiting_on_display: string;
  /** ISO timestamp — the `wait_entered` event's `at`. */
  entered_at: string;
  /** Elapsed since `entered_at` at SSR — used to color the row before the client hydrates. */
  gap_ms: number;
  /** SLA looked up in mario_thresholds by (wait_kind, wait_exited) or a wait-specific pair; null
   *  when no threshold is configured — the row renders in neutral sky in that case. */
  sla_ms: number | null;
}

interface LifecycleTimelineProps {
  derivation: LifecycleDerivation;
  /** Override the default pill label on the current stage (e.g. "Building…" from the live job). */
  currentLabel?: string;
  /** Tooltip on the current stage's pill (rendered on hover). */
  currentTitle?: string;
  /** "card" (default) = on a board / detail card; "compact" = a denser variant (smaller dot, tighter gaps). */
  density?: "card" | "compact";
  /** Phase 1 — the M1 SDK timecard view for this spec; when present the timeline paints per-stage
   *  duration + inter-stage gap pills. Omit for board-card usage (no per-spec time context). */
  timecard?: TimecardView;
  /** Phase 1 — mario_thresholds rows for the workspace, keyed by (from_event, to_event). Used
   *  to color inter-stage gap pills: under sla_ms = zinc, over = amber, over 2× = rose. Omit
   *  to render every gap pill neutral. */
  thresholds?: MarioThreshold[];
  /** Phase 2 — resolved open-wait rows (workspace_members display_name / dep title / static
   *  labels applied server-side). Rendered below the 5-node row via {@link WaitRow}; when
   *  empty or omitted no wait section renders (backward-compat with Phase-1 shape). */
  waits?: WaitDisplay[];
  /** Phase 3 — when true, the spec has reached a terminal marker (folded / phase_shipped) and
   *  the TotalElapsed badge renders a static "Total: <duration>" instead of mounting the live
   *  {@link RunningTimer} island. Default false — a live in-progress spec ticks. */
  terminal?: boolean;
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

/**
 * Format a millisecond count as a compact h/m/s label — the shape the roadmap board reads at a
 * glance. Returns "42s", "3m 12s", "2h 4m", "1d 3h" — one unit crosses the threshold, one
 * subordinate unit rides along. Zero/negative → "0s" so nothing NaNs on a bad row.
 */
export function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

/**
 * Map a lifecycle stage to the (start_event, done_event) pair on the timecard that bounds it.
 * `spec-review` accepts both review_passed and review_failed as done markers; `fold` accepts
 * `fold_done` and the legacy `folded` marker; `security-test` collapses to a single-point
 * verdict event (start === done), which surfaces as no per-stage duration label.
 *
 * Fix 1 (Phase 4) — the M3 SLA rows in `mario_thresholds` are keyed on the (build_done →
 * phase_shipped) transition (a PR-shipping gap). `spec-test` therefore lists `phase_shipped`
 * FIRST in its start-event list so the inbound-gap resolver picks up that pair when both are
 * present, and the pill lights amber past sla_ms / rose past 2× sla_ms. `spec_test_started`
 * remains as the fallback for a spec where the pre-test agent already scheduled but the
 * phase-shipping event hasn't landed yet (unlikely but non-crashy).
 */
const STAGE_TIMECARD_KIND: Record<LifecycleStageName, { start: string[]; done: string[] }> = {
  "spec-review": { start: ["review_started"], done: ["review_passed", "review_failed"] },
  "build": { start: ["build_started"], done: ["build_done"] },
  "spec-test": { start: ["phase_shipped", "spec_test_started"], done: ["spec_test_verdict"] },
  "security-test": { start: ["security_verdict"], done: ["security_verdict"] },
  "fold": { start: ["fold_started"], done: ["fold_done", "folded"] },
};

/**
 * Find the first `TimecardStep` in `steps` whose `event_kind` matches one of `kinds`. Kinds are
 * ordered by preference — the first hit wins so `review_passed` beats `review_failed` when both
 * were emitted (unusual but defensible).
 */
function findStep(steps: TimecardStep[], kinds: readonly string[]): TimecardStep | null {
  for (const kind of kinds) {
    const hit = steps.find((s) => s.event_kind === kind);
    if (hit) return hit;
  }
  return null;
}

/**
 * Look up the SLA (in ms) for the transition (from_event, to_event) in the thresholds list.
 * Prefers a workspace-specific row over a null-workspace default when both exist. Returns null
 * when no matching threshold is configured — the caller renders the gap in neutral zinc.
 */
function findSla(thresholds: readonly MarioThreshold[], from_event: string, to_event: string): number | null {
  const hit = thresholds.find((t) => t.from_event === from_event && t.to_event === to_event);
  return hit ? hit.sla_ms : null;
}

/**
 * Pill color for an inter-stage gap given the gap and the SLA. Under SLA (or no SLA available)
 * → neutral zinc; over SLA → amber; over 2× SLA → rose. Matches the goal's zinc/amber/rose
 * palette and the color contract the brain page documents.
 */
function gapPillClass(gap_ms: number, sla_ms: number | null): string {
  const neutral = "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-300";
  if (sla_ms === null || sla_ms <= 0) return neutral;
  if (gap_ms > sla_ms * 2) return "bg-rose-50 text-rose-500 dark:bg-rose-950/30";
  if (gap_ms > sla_ms) return "bg-amber-50 text-amber-500 dark:bg-amber-950/30";
  return neutral;
}

/**
 * Text color for a WaitRow given its elapsed gap and the SLA. A fresh wait (under SLA or no SLA
 * configured) reads sky (a running wait, not a warning); over SLA reads amber; over 2× SLA reads
 * rose. Palette matches the spec's Phase-2 "text-sky-500 / text-amber-500 / text-rose-500" color
 * contract.
 */
function waitRowTextClass(gap_ms: number, sla_ms: number | null): string {
  if (sla_ms === null || sla_ms <= 0) return "text-sky-500";
  if (gap_ms > sla_ms * 2) return "text-rose-500";
  if (gap_ms > sla_ms) return "text-amber-500";
  return "text-sky-500";
}

/**
 * Resolve a per-stage duration and an inbound gap for each of the 5 stages, given the timecard
 * and thresholds. Returned in stage-order. When the timecard is undefined, returns nulls so the
 * caller can render the timeline in its Phase-2 (no-timecard) shape without a visual regression.
 */
function computeStageTiming(
  stageNames: readonly LifecycleStageName[],
  timecard: TimecardView | undefined,
  thresholds: readonly MarioThreshold[],
): Array<{ duration_ms: number | null; gap_ms: number | null; sla_ms: number | null; gap_from_event: string | null }> {
  if (!timecard) return stageNames.map(() => ({ duration_ms: null, gap_ms: null, sla_ms: null, gap_from_event: null }));
  const perStage = stageNames.map((name) => {
    const bounds = STAGE_TIMECARD_KIND[name];
    const start = findStep(timecard.steps, bounds.start);
    const done = findStep(timecard.steps, bounds.done);
    const duration_ms = start && done ? Date.parse(done.at) - Date.parse(start.at) : null;
    return { name, start, done, duration_ms };
  });
  return perStage.map((s, i) => {
    // The inbound gap is (this stage's start - previous stage's done). Both must exist for the
    // gap to render — a stage the spec hasn't reached yet has no inbound gap to color.
    let gap_ms: number | null = null;
    let sla_ms: number | null = null;
    let gap_from_event: string | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = perStage[j]!;
      if (prev.done && s.start) {
        gap_ms = Math.max(0, Date.parse(s.start.at) - Date.parse(prev.done.at));
        gap_from_event = prev.done.event_kind;
        sla_ms = findSla(thresholds, prev.done.event_kind, s.start.event_kind);
        break;
      }
    }
    return { duration_ms: s.duration_ms, gap_ms, sla_ms, gap_from_event };
  });
}

/**
 * A single open-wait row rendered below the 5-node timeline. Server-rendered wrapper — the
 * live-ticking duration is the {@link WaitTimer} client island. The `waiting_on_display` label
 * is resolved server-side in [slug]/page.tsx BEFORE this component sees it, so the row never
 * shows a raw slug / UUID.
 */
function WaitRow({ wait }: { wait: WaitDisplay }) {
  const textClass = waitRowTextClass(wait.gap_ms, wait.sla_ms);
  return (
    <div className={`mt-2 flex items-center justify-between gap-2 rounded-md border border-zinc-100 bg-zinc-50 px-2 py-1 text-[11px] dark:border-zinc-800 dark:bg-zinc-900/40 ${textClass}`}>
      <span className="truncate">Waiting on {wait.waiting_on_display}</span>
      <span className="whitespace-nowrap font-medium tabular-nums">
        <WaitTimer since={wait.entered_at} />
      </span>
    </div>
  );
}

export default function LifecycleTimeline({
  derivation,
  currentLabel,
  currentTitle,
  density = "card",
  timecard,
  thresholds,
  waits,
  terminal,
}: LifecycleTimelineProps) {
  const { stages, current } = derivation;
  const dot = density === "compact" ? "h-4 w-4 text-[10px]" : "h-5 w-5 text-[11px]";
  const labelText = density === "compact" ? "text-[9px]" : "text-[10px]";
  const timing = computeStageTiming(
    stages.map((s) => s.name),
    timecard,
    thresholds ?? [],
  );
  // Phase 3 — the top-of-block "Elapsed:" or "Total:" badge. Only renders when a timecard is
  // present AND the ledger has at least one event (a fresh spec with no rows shows nothing so
  // the board card + folded chip stay visually identical). A terminal spec renders a static
  // "Total: <duration>" — the RunningTimer client island is not mounted so no client tick fires
  // (Phase 3 verification: "does NOT tick — expect no re-render of the timer node").
  const showTimer = !!timecard && !!timecard.first_event_at;
  return (
    <div className="mt-2 w-full">
      {showTimer && (
        <div className={`mb-1 flex items-center justify-end ${labelText}`}>
          {terminal ? (
            <span className="text-zinc-500 dark:text-zinc-400">
              Total: <span className="font-medium text-zinc-700 dark:text-zinc-200">{formatDurationCompact(timecard!.total_elapsed_ms)}</span>
            </span>
          ) : (
            <RunningTimer since={timecard!.first_event_at!} label="Elapsed:" />
          )}
        </div>
      )}
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
              {/* Phase 1 — per-stage duration (start-event → done-event span from the M1 timecard) and
                  inbound gap pill (previous-stage-done → this-stage-start, colored by mario_thresholds
                  SLA). Only render when the timecard prop is present; the board card omits both. */}
              {timing[idx]?.duration_ms !== null && timing[idx]?.duration_ms !== undefined && (
                <span
                  className={`mt-0.5 block text-center ${labelText} text-zinc-400 dark:text-zinc-300`}
                  title={`${stage.label} took ${formatDurationCompact(timing[idx]!.duration_ms!)}`}
                >
                  {formatDurationCompact(timing[idx]!.duration_ms!)}
                </span>
              )}
              {timing[idx]?.gap_ms !== null && timing[idx]?.gap_ms !== undefined && (
                <span
                  className={`mt-0.5 inline-flex max-w-full items-center truncate rounded-full px-1.5 py-0.5 text-[9px] font-medium ${gapPillClass(timing[idx]!.gap_ms!, timing[idx]!.sla_ms)}`}
                  title={
                    timing[idx]!.sla_ms
                      ? `gap ${formatDurationCompact(timing[idx]!.gap_ms!)} (SLA ${formatDurationCompact(timing[idx]!.sla_ms!)})`
                      : `gap ${formatDurationCompact(timing[idx]!.gap_ms!)}`
                  }
                >
                  +{formatDurationCompact(timing[idx]!.gap_ms!)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {waits && waits.length > 0 && (
        <div>
          {waits.map((wait, i) => (
            <WaitRow key={`${wait.wait_kind}-${wait.entered_at}-${i}`} wait={wait} />
          ))}
        </div>
      )}
    </div>
  );
}
