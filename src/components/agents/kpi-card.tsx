"use client";

/**
 * Reusable KPI cards for the per-agent KPI page (agent-kpi-pages-cleo-first Phase 2).
 *
 * The KPI page renders the tiered [[@/lib/agents/agent-kpis|computeAgentKpis]] structure
 * generically — one `<KpiCard>` per card, plus a richer `<PostureCard>` variant for the
 * Tier 1 "On it" headline so the answer to "is she on it" is legible at a glance.
 *
 * The SDK sets `tone` from the underlying signal; this component only renders it — it
 * never re-interprets or overrides. `source` is exposed via a title tooltip so a
 * skeptical viewer can trace the value back to its table.
 */
import type { KpiCard as KpiCardData } from "@/lib/agents/agent-kpis";

/** Tailwind classes per polarity — kept static so the JIT preserves them. */
const TONE = {
  good: {
    ring: "border-emerald-200 dark:border-emerald-900/40",
    accent: "text-emerald-700 dark:text-emerald-300",
    dot: "bg-emerald-500",
  },
  bad: {
    ring: "border-rose-200 dark:border-rose-900/40",
    accent: "text-rose-700 dark:text-rose-300",
    dot: "bg-rose-500",
  },
  neutral: {
    ring: "border-zinc-200 dark:border-zinc-800",
    accent: "text-zinc-800 dark:text-zinc-100",
    dot: "bg-zinc-400",
  },
} as const;

/** Format the SDK value + optional unit — "$" is a prefix, everything else a suffix. */
function formatValue(value: KpiCardData["value"], unit?: string): string {
  if (value === null || value === undefined) return "—";
  const str = typeof value === "number" ? value.toLocaleString() : String(value);
  if (!unit) return str;
  if (unit === "$") return `$${str}`;
  return `${str}${unit === "%" || unit === "/10" ? unit : ` ${unit}`}`;
}

/** Trend arrow next to the value. `flat` shows a dash so a "no movement" signal is visible. */
function TrendGlyph({ trend }: { trend: NonNullable<KpiCardData["trend"]> }) {
  const pct = trend.pct !== undefined ? Math.abs(trend.pct) : null;
  const pctStr = pct !== null ? `${pct.toFixed(1)}%` : "";
  if (trend.dir === "up") {
    return (
      <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
        <span aria-hidden>▲</span>
        {pctStr}
      </span>
    );
  }
  if (trend.dir === "down") {
    return (
      <span className="inline-flex items-center gap-0.5 text-rose-600 dark:text-rose-400">
        <span aria-hidden>▼</span>
        {pctStr}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-zinc-400">
      <span aria-hidden>—</span>
      {pctStr}
    </span>
  );
}

/**
 * The standard KPI tile — label, big value + unit, optional trend arrow, subtitle, and a
 * source tooltip. Tone comes from the SDK.
 */
export function KpiCard({ card }: { card: KpiCardData }) {
  const tone = TONE[card.tone];
  return (
    <div
      className={`rounded-lg border bg-white px-4 py-3 dark:bg-zinc-950 ${tone.ring}`}
      title={`Source: ${card.source}`}
    >
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
        {card.label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-2xl font-semibold tabular-nums ${tone.accent}`}>
          {formatValue(card.value, card.unit)}
        </span>
        {card.trend && (
          <span className="text-[12px] tabular-nums">
            <TrendGlyph trend={card.trend} />
          </span>
        )}
      </div>
      {card.subtitle && (
        <p className="mt-1 line-clamp-2 text-[12px] text-zinc-500 dark:text-zinc-400">
          {card.subtitle}
        </p>
      )}
    </div>
  );
}

/**
 * The richer "On it" posture card — surfaces the recency dot (green if the last pass
 * was under 24h), the posture line ("Monitoring N experiments; M/K free"), and the
 * companion counts (experiments-in-flight + awaiting-owner) inline so the reader can
 * answer "is she on it?" without scrolling.
 *
 * Sourced from the four "on-it" tier cards the SDK emits (`on-it` · `why-not-proposing`
 * · `experiments-in-flight` · `awaiting-owner` for Cleo; the generic fallback still
 * emits `on-it` so this variant is safe for every agent).
 */
export function PostureCard({ cards }: { cards: KpiCardData[] }) {
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const onIt = byKey.get("on-it");
  if (!onIt) return null;
  const inFlight = byKey.get("experiments-in-flight");
  const awaiting = byKey.get("awaiting-owner");
  const why = byKey.get("why-not-proposing");
  const tone = TONE[onIt.tone];
  return (
    <div
      className={`rounded-lg border bg-white px-4 py-4 dark:bg-zinc-950 ${tone.ring}`}
      title={`Source: ${onIt.source}`}
    >
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
        On it
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={`text-2xl font-semibold ${tone.accent}`}>
          {formatValue(onIt.value, onIt.unit)}
        </span>
        <span className="text-[12px] text-zinc-500">last pass</span>
      </div>
      {(onIt.subtitle || why?.subtitle) && (
        <p className="mt-2 text-[13px] text-zinc-700 dark:text-zinc-200">
          {onIt.subtitle ?? why?.subtitle}
        </p>
      )}
      {(inFlight || awaiting) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-zinc-500 dark:text-zinc-400">
          {inFlight && (
            <span>
              <span className="font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                {formatValue(inFlight.value, inFlight.unit)}
              </span>{" "}
              in flight
              {inFlight.subtitle && ` · ${inFlight.subtitle}`}
            </span>
          )}
          {awaiting && (
            <span>
              <span className="font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                {formatValue(awaiting.value, awaiting.unit)}
              </span>{" "}
              awaiting owner
            </span>
          )}
        </div>
      )}
    </div>
  );
}
