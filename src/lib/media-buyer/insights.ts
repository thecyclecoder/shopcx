/**
 * Media Buyer insights SDK — per-copy-mode leading signals for the M3 flag-graduation gate
 * (docs/brain/specs/dahlia-cold-graded-inline-link-ctr-leading-signal.md Phase 2).
 *
 * The success metric of Dahlia's copy-author box session is comparative: "author-mode creatives
 * beat deterministic slot-fill on realized cold-audience CAC/CTR." That comparison is only
 * defensible if realized outcomes are bucketed by copy mode. This SDK reads the split column
 * shipped in the sibling migration ([[../../tables/media_buyer_action_grades]] `dahlia_copy_mode`),
 * joins to attributed spend/orders + Meta inline-link-clicks/impressions, and returns a per-mode
 * bucket the Growth-Director-visible graduation gate reads directly.
 *
 * Two consumer paths (both surfaced on [[../functions/growth]]):
 *   • Bianca's grader digest ([[./director-digest]]) prints the per-mode delta every pass so
 *     #director-growth-max sees the M3 signal in the same feed as promote/kill grade averages.
 *   • The flag-graduation gate recommends flipping DAHLIA_COPY_MODE default from 'deterministic'
 *     to 'author' only when the helper returns `insufficient_data:false` AND author's cac +
 *     inline_link_ctr beat deterministic's on ≥N grade rows.
 *
 * Sample-size guard: when either bucket has fewer than PER_COPY_MODE_MIN_N grade rows in the
 * trailing window the helper returns `insufficient_data:true` so a caller can't false-graduate
 * on noise. Both consumer paths respect the flag before recommending a flip.
 *
 * NULL semantics (M3 measurement-lane invariant):
 *   • A `dahlia_copy_mode = null` grade row is EXCLUDED from every bucket (pre-migration state
 *     or an off-platform ad — treating it as either mode would poison the delta).
 *   • A `meta_insights_daily.inline_link_clicks = null` row is EXCLUDED from the CTR numerator
 *     AND denominator (its impressions do NOT count either) — Meta didn't report link clicks
 *     for that day and treating unknown as 0 is exactly the false-success the M3 spec calls out.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { DahliaCopyMode } from "./grader";

type Admin = ReturnType<typeof createAdminClient>;

/** How many grade rows either bucket needs in the trailing window before the helper is trusted. */
export const PER_COPY_MODE_MIN_N = 20;

/** Actions whose realized outcome carries the leading signal — the M3 gate's own action-kind whitelist. */
export const PER_COPY_MODE_GRADEABLE_KINDS = [
  "media_buyer_promoted_winner",
  "media_buyer_paused_loser",
] as const;

/** Per-mode rolled-up leading signal — CAC (attributed spend per Meta-attributed order) + inline-link-CTR. */
export interface PerCopyModeBucket {
  /** Grade rows counted in the bucket after applying dahlia_copy_mode + action_kind + window filters. */
  n: number;
  /** SUM(attributed_spend_cents) across the bucket's meta_attribution_daily rows. */
  attributed_spend_cents: number;
  /** SUM(orders) across the bucket's meta_attribution_daily rows. */
  orders: number;
  /** CAC in cents = attributed_spend_cents / orders (null when orders=0 — treat as unknown, not ∞). */
  cac_cents: number | null;
  /** SUM(impressions) across the bucket's meta_insights_daily rows, EXCLUDING rows with NULL inline_link_clicks. */
  impressions: number;
  /** SUM(inline_link_clicks) across the bucket's meta_insights_daily rows, EXCLUDING NULLs. */
  inline_link_clicks: number;
  /** inline_link_clicks / impressions (null when impressions=0). Dahlia's leading signal for the M3 gate. */
  inline_link_ctr: number | null;
}

/** The helper's return shape — two buckets + a delta the flag-graduation gate reads directly. */
export interface PerCopyModeCtrCac {
  author: PerCopyModeBucket;
  deterministic: PerCopyModeBucket;
  /** author minus deterministic on each axis (null when either side is null). */
  delta: {
    cac_cents: number | null;
    inline_link_ctr: number | null;
  };
  /** The window that was scanned (inclusive UTC dates). */
  window: { since: string; until: string };
  /** true when either bucket has n<PER_COPY_MODE_MIN_N — caller must NOT act on the delta. */
  insufficient_data: boolean;
}

interface GradeRow {
  source_meta_ad_id: string | null;
  dahlia_copy_mode: DahliaCopyMode | null;
  action_kind: string;
  graded_at: string;
}

interface AttributionRow {
  meta_ad_id: string;
  attributed_spend_cents: number | string | null;
  orders: number | string | null;
  snapshot_date: string;
}

interface InsightsRow {
  meta_object_id: string;
  impressions: number | string | null;
  inline_link_clicks: number | string | null;
  snapshot_date: string;
}

function emptyBucket(): PerCopyModeBucket {
  return {
    n: 0,
    attributed_spend_cents: 0,
    orders: 0,
    cac_cents: null,
    impressions: 0,
    inline_link_clicks: 0,
    inline_link_ctr: null,
  };
}

function num(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure aggregator — given the raw graded rows + the matching attribution/insight rows,
 * bucket by dahlia_copy_mode and roll up per-mode CAC + inline-link-CTR. Exposed as its own
 * export so unit tests hit this without touching Supabase.
 *
 * NULL rules (pinned as tests):
 *   • grade rows with `dahlia_copy_mode = null` are dropped BEFORE bucketing (see NULL semantics
 *     in the module header).
 *   • insights rows with `inline_link_clicks = null` are dropped from the CTR numerator AND
 *     denominator — their impressions are NOT counted (Meta didn't report link clicks; treating
 *     unknown as 0 is the false-success the M3 spec calls out).
 */
export function aggregatePerCopyMode(
  grades: GradeRow[],
  attribution: AttributionRow[],
  insights: InsightsRow[],
  window: { since: string; until: string },
): PerCopyModeCtrCac {
  const author = emptyBucket();
  const deterministic = emptyBucket();

  const metaAdIdsByMode: Record<DahliaCopyMode, Set<string>> = {
    author: new Set(),
    deterministic: new Set(),
  };
  const validKinds = new Set(PER_COPY_MODE_GRADEABLE_KINDS as readonly string[]);
  for (const g of grades) {
    if (g.dahlia_copy_mode == null) continue;
    if (!validKinds.has(g.action_kind)) continue;
    if (!g.source_meta_ad_id) continue;
    metaAdIdsByMode[g.dahlia_copy_mode].add(g.source_meta_ad_id);
    if (g.dahlia_copy_mode === "author") author.n += 1;
    else deterministic.n += 1;
  }

  for (const row of attribution) {
    const inAuthor = metaAdIdsByMode.author.has(row.meta_ad_id);
    const inDeterministic = metaAdIdsByMode.deterministic.has(row.meta_ad_id);
    if (!inAuthor && !inDeterministic) continue;
    const bucket = inAuthor ? author : deterministic;
    bucket.attributed_spend_cents += num(row.attributed_spend_cents);
    bucket.orders += num(row.orders);
  }

  for (const row of insights) {
    // NULL inline_link_clicks — EXCLUDE from both numerator AND denominator (impressions too).
    if (row.inline_link_clicks == null || row.inline_link_clicks === "") continue;
    const inAuthor = metaAdIdsByMode.author.has(row.meta_object_id);
    const inDeterministic = metaAdIdsByMode.deterministic.has(row.meta_object_id);
    if (!inAuthor && !inDeterministic) continue;
    const bucket = inAuthor ? author : deterministic;
    bucket.impressions += num(row.impressions);
    bucket.inline_link_clicks += num(row.inline_link_clicks);
  }

  for (const b of [author, deterministic]) {
    b.cac_cents = b.orders > 0 ? Math.round(b.attributed_spend_cents / b.orders) : null;
    b.inline_link_ctr = b.impressions > 0 ? Number((b.inline_link_clicks / b.impressions).toFixed(6)) : null;
  }

  const deltaCac =
    author.cac_cents == null || deterministic.cac_cents == null ? null : author.cac_cents - deterministic.cac_cents;
  const deltaCtr =
    author.inline_link_ctr == null || deterministic.inline_link_ctr == null
      ? null
      : Number((author.inline_link_ctr - deterministic.inline_link_ctr).toFixed(6));

  return {
    author,
    deterministic,
    delta: { cac_cents: deltaCac, inline_link_ctr: deltaCtr },
    window,
    insufficient_data: author.n < PER_COPY_MODE_MIN_N || deterministic.n < PER_COPY_MODE_MIN_N,
  };
}

/**
 * Read the per-copy-mode leading signal over a trailing window for one workspace.
 *
 *   1. Pull [[../../tables/media_buyer_action_grades]] rows over the last `days` days, filtered
 *      to the gradeable action-kinds and the requested `audienceCohort` (today: only `cold`,
 *      which the caller enforces — this helper doesn't currently constrain on cohort further
 *      because the cold-cohort provisioner is the only path that seeds media-buyer test ads
 *      today; the arg is present so a future warm/hot lane can consume the same seam).
 *   2. Pull [[../../tables/meta_attribution_daily]] rows for the source Meta ad ids over the
 *      same window — CAC lives in `orders` + `attributed_spend_cents`.
 *   3. Pull [[../../tables/meta_insights_daily]] rows at `level='ad'` for those Meta ad ids over
 *      the same window — CTR lives in `impressions` + `inline_link_clicks` (from the sibling
 *      Phase-1 migration).
 *   4. Aggregate via {@link aggregatePerCopyMode} and return the two buckets + delta +
 *      insufficient_data flag.
 */
export async function getPerCopyModeCtrCac(
  admin: Admin,
  workspaceId: string,
  opts?: { days?: number; audienceCohort?: "cold" | "warm" | "hot"; nowMs?: number },
): Promise<PerCopyModeCtrCac> {
  const days = opts?.days ?? 14;
  const nowMs = opts?.nowMs ?? Date.now();
  const untilMs = nowMs;
  const sinceMs = nowMs - days * 86400_000;
  const window = {
    since: new Date(sinceMs).toISOString().slice(0, 10),
    until: new Date(untilMs).toISOString().slice(0, 10),
  };

  const { data: gradesRaw } = await admin
    .from("media_buyer_action_grades")
    .select("source_meta_ad_id, dahlia_copy_mode, action_kind, graded_at")
    .eq("workspace_id", workspaceId)
    .in("action_kind", PER_COPY_MODE_GRADEABLE_KINDS as readonly string[])
    .gte("graded_at", new Date(sinceMs).toISOString())
    .lte("graded_at", new Date(untilMs).toISOString());
  const grades = (gradesRaw || []) as GradeRow[];
  const metaAdIds = Array.from(new Set(grades.map((g) => g.source_meta_ad_id).filter((s): s is string => !!s)));

  if (metaAdIds.length === 0) {
    return aggregatePerCopyMode(grades, [], [], window);
  }

  const { data: attributionRaw } = await admin
    .from("meta_attribution_daily")
    .select("meta_ad_id, attributed_spend_cents, orders, snapshot_date")
    .eq("workspace_id", workspaceId)
    .in("meta_ad_id", metaAdIds)
    .gte("snapshot_date", window.since)
    .lte("snapshot_date", window.until);
  const attribution = (attributionRaw || []) as AttributionRow[];

  const { data: insightsRaw } = await admin
    .from("meta_insights_daily")
    .select("meta_object_id, impressions, inline_link_clicks, snapshot_date")
    .eq("workspace_id", workspaceId)
    .eq("level", "ad")
    .in("meta_object_id", metaAdIds)
    .gte("snapshot_date", window.since)
    .lte("snapshot_date", window.until);
  const insights = (insightsRaw || []) as InsightsRow[];

  return aggregatePerCopyMode(grades, attribution, insights, window);
}
