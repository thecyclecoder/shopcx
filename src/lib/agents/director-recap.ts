/**
 * Director EOD recap — the end-of-day standup post (directors-board-gamified spec, Phase 4).
 *
 * The day closes with a standup recap: per ACTIVE director, aggregate the day's activity from existing
 * truth (approval_decisions · merged builds · director_activity), narrate it as a conversational `recap`
 * post on the #directors board, AND surface it in the M1 Daily Summaries tab (a dashboard_notifications
 * `agent_daily_summary` row). The CEO recap is a roll-up across every director — the company standup.
 *
 * This EXTENDS the daily-analysis-report aggregate-then-narrate shape ([[daily-analysis-report]]
 * generateDailyReport) to the director domain — but narrates DETERMINISTICALLY in each persona's voice
 * (no LLM call, no API key): the counts are a derived, display-only proxy (the spec's North-star
 * invariant — XP/recap is never an objective the directors optimize). Server-only (createAdminClient +
 * brain-roadmap fs reads). Run by the daily cron ([[../inngest/director-recap-cron]]) or on-demand.
 * See docs/brain/libraries/director-recap.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap, getFunctions } from "@/lib/brain-roadmap";
import { getPersona } from "@/lib/agents/personas";
import { postDirectorMessage } from "@/lib/agents/director-board";
import { DAILY_SUMMARY_TYPE } from "@/lib/agents/inbox";
import {
  composeScorecardWatchLine,
  type Cadence as ScorecardCadence,
  type ScorecardSnapshotLite,
} from "@/lib/agents/platform-scorecard-display";

/** The Platform director's function slug — the one whose recap deep-links to the scorecard surface
 *  ([[../specs/platform-scorecard-surface]] Phase 3). */
const PLATFORM_FUNCTION = "platform";

/** The job kinds whose approved request is a "bug fixed" (mirrors director-xp FIX_JOB_KINDS). */
const FIX_JOB_KINDS = new Set(["repair", "regression"]);
/** The job kind whose approved request is a "migration approved" (the billing migration-fix repairs). */
const MIGRATION_JOB_KINDS = new Set(["migration-fix"]);
/** director_activity action kinds that mean a goal/milestone was advanced (live directors, M4+). */
const GOAL_ADVANCE_KINDS = new Set(["escorted_goal", "advanced_milestone", "shipped_milestone"]);

/** One director's aggregated activity for the day — the four spec-named counts + context. */
export interface DirectorDayStats {
  /** merged builds owned by the function today. */
  specsShipped: number;
  /** milestones advanced today (director_activity goal-advance actions). */
  goalsAdvanced: number;
  /** approved repair/regression fixes handled today. */
  bugsFixed: number;
  /** approved migration-fix decisions handled today. */
  migrationsApproved: number;
  /** every approved decision the director handled today (bugs + migrations + other). */
  approvalsHandled: number;
  /** total director_activity rows logged today (the active signal even with no headline count). */
  actions: number;
}

export type DirectorRecapMap = Record<string, DirectorDayStats>;

const emptyStats = (): DirectorDayStats => ({
  specsShipped: 0,
  goalsAdvanced: 0,
  bugsFixed: 0,
  migrationsApproved: 0,
  approvalsHandled: 0,
  actions: 0,
});

/** A director is "active" for the day if it has ANY signal — a headline count, an approval, or an action. */
function isActive(s: DirectorDayStats): boolean {
  return (
    s.specsShipped > 0 ||
    s.goalsAdvanced > 0 ||
    s.bugsFixed > 0 ||
    s.migrationsApproved > 0 ||
    s.approvalsHandled > 0 ||
    s.actions > 0
  );
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "shipped N specs · advanced M goals · fixed K bugs · approved J migrations" — non-zero parts only. */
function summaryLine(s: DirectorDayStats): string {
  const parts: string[] = [];
  if (s.specsShipped) parts.push(`shipped ${plural(s.specsShipped, "spec")}`);
  if (s.goalsAdvanced) parts.push(`advanced ${plural(s.goalsAdvanced, "goal")}`);
  if (s.bugsFixed) parts.push(`fixed ${plural(s.bugsFixed, "bug")}`);
  if (s.migrationsApproved) parts.push(`approved ${plural(s.migrationsApproved, "migration")}`);
  // a director that only handled generic (non-bug, non-migration) approvals still reads as busy.
  const otherApprovals = s.approvalsHandled - s.bugsFixed - s.migrationsApproved;
  if (otherApprovals > 0) parts.push(`cleared ${plural(otherApprovals, "approval")}`);
  if (parts.length) return parts.join(" · ");
  if (s.actions) return `logged ${plural(s.actions, "action")}`;
  return "a quiet day — nothing shipped";
}

/** A director's conversational recap post, in persona voice (plain text, no markdown). */
export function composeDirectorRecap(slug: string, s: DirectorDayStats): string {
  const persona = getPersona(slug);
  return `${persona.emoji} EOD recap — ${summaryLine(s)}.`;
}

/** The CEO company-standup roll-up across every active director (plain text, no markdown). */
export function composeCeoRollup(total: DirectorDayStats, activeDirectors: number): string {
  const ceo = getPersona("ceo");
  const tail = activeDirectors
    ? ` across ${plural(activeDirectors, "active director")}`
    : ` — a quiet day on the board`;
  return `${ceo.emoji} Company standup — ${summaryLine(total)}${tail}.`;
}

// ── The human-readable detail page (director-loop-grading spec, Phase 5) ─────────────────────────────
//
// The one-line standup (composeDirectorRecap) is the headline; this is the DRILL-DOWN — a readable
// narrative of the director's day built by reading that day's director_activity rows (each row's
// `reason` = the plain-text "why"), grouped by category: what it fixed + why, which goal it moved + how
// far, what it escalated. A pure query over the activity log, never hand-maintained (the spec's North-star
// invariant). Rendered on /dashboard/agents/recap/{date} via GET /api/developer/agents/recap.

/** action_kind → its readable label + the category it groups under in the day narrative. */
const ACTION_META: Record<string, { category: string; label: string }> = {
  // goals (the live directors, M4+)
  escorted_goal: { category: "Goals advanced", label: "Escorted a goal" },
  advanced_milestone: { category: "Goals advanced", label: "Advanced a milestone" },
  shipped_milestone: { category: "Goals advanced", label: "Shipped a milestone" },
  // fixes / repairs
  authored_fix: { category: "Fixes & repairs", label: "Authored a fix" },
  fixed_bug: { category: "Fixes & repairs", label: "Fixed a bug" },
  coaching_routed_to_repair: { category: "Fixes & repairs", label: "Routed coaching to repair" },
  // approvals
  approved_approval: { category: "Approvals", label: "Approved a request" },
  approved_migration: { category: "Approvals", label: "Approved a migration" },
  // watch / regression
  detected_regression: { category: "Platform watch", label: "Detected a regression" },
  dismissed_regression: { category: "Platform watch", label: "Dismissed a regression (no-op)" },
  // board grooming
  groomed_continue: { category: "Board grooming", label: "Groomed a card — continue" },
  groomed_split: { category: "Board grooming", label: "Groomed a card — split" },
  // coaching
  coached_worker: { category: "Worker coaching", label: "Coached a worker" },
  // escalations
  escalated: { category: "Escalations", label: "Escalated to the CEO" },
  escalated_coaching: { category: "Escalations", label: "Escalated coaching to the CEO" },
};

/** Stable render order — the headline categories first, the catch-all last. */
const CATEGORY_ORDER = [
  "Goals advanced",
  "Fixes & repairs",
  "Approvals",
  "Platform watch",
  "Board grooming",
  "Worker coaching",
  "Escalations",
  "Activity",
];

const humanizeKind = (kind: string): string => kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function actionMeta(kind: string): { category: string; label: string } {
  return ACTION_META[kind] ?? { category: "Activity", label: humanizeKind(kind) };
}

/** One activity row, narrated — the action + the spec it touched + its plain-text "why". */
export interface DayNarrativeItem {
  actionKind: string;
  actionLabel: string;
  category: string;
  specSlug: string | null;
  reason: string;
  createdAt: string;
}

export interface DayNarrativeGroup {
  category: string;
  items: DayNarrativeItem[];
}

/** One director's narrated day — persona header + grouped activity + a short count headline. */
export interface DirectorDayNarrative {
  functionSlug: string;
  personaName: string;
  personaRole: string;
  personaEmoji: string;
  /** "2 goals advanced · 3 fixes · 1 escalation" — a count summary of the groups below. */
  headline: string;
  groups: DayNarrativeGroup[];
  total: number;
}

export interface DayNarrative {
  date: string;
  /** `director` = one function's day; `company` = every active director (the CEO roll-up). */
  scope: "director" | "company";
  directors: DirectorDayNarrative[];
  empty: boolean;
}

type ActivityRow = {
  director_function: string;
  action_kind: string;
  spec_slug: string | null;
  reason: string | null;
  created_at: string;
};

/** Group + order one function's activity rows, with a count headline. */
function narrateDirector(slug: string, rows: ActivityRow[]): DirectorDayNarrative {
  const persona = getPersona(slug);
  const byCategory = new Map<string, DayNarrativeItem[]>();
  for (const r of rows) {
    const meta = actionMeta(r.action_kind);
    const item: DayNarrativeItem = {
      actionKind: r.action_kind,
      actionLabel: meta.label,
      category: meta.category,
      specSlug: r.spec_slug,
      reason: (r.reason ?? "").trim(),
      createdAt: r.created_at,
    };
    const arr = byCategory.get(meta.category) ?? [];
    arr.push(item);
    byCategory.set(meta.category, arr);
  }
  const groups: DayNarrativeGroup[] = CATEGORY_ORDER.filter((c) => byCategory.has(c)).map((category) => ({
    category,
    // newest action first within a category (mirrors the activity log read order).
    items: (byCategory.get(category) ?? []).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  }));
  const headline = groups.map((g) => plural(g.items.length, g.category.toLowerCase())).join(" · ") || "a quiet day";
  return {
    functionSlug: slug,
    personaName: persona.name,
    personaRole: persona.role,
    personaEmoji: persona.emoji,
    headline,
    groups,
    total: rows.length,
  };
}

/**
 * Build the human-readable day narrative for a workspace + date (UTC) — a pure query over that day's
 * director_activity rows. With `functionSlug` → just that director's day; without → every active
 * director (the company roll-up). Idempotent + side-effect-free (read-only); recomputed on each view so
 * it can never drift from the log it narrates.
 */
export async function buildDirectorDayNarrative(input: {
  workspaceId: string;
  date: string;
  functionSlug?: string;
}): Promise<DayNarrative> {
  const { workspaceId, date, functionSlug } = input;
  const scope: DayNarrative["scope"] = functionSlug ? "director" : "company";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { date, scope, directors: [], empty: true };

  const admin = createAdminClient();
  const dayStart = new Date(date + "T00:00:00.000Z").toISOString();
  const dayEnd = new Date(new Date(date + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000).toISOString();

  let query = admin
    .from("director_activity")
    .select("director_function, action_kind, spec_slug, reason, created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", dayStart)
    .lt("created_at", dayEnd)
    .order("created_at", { ascending: false });
  if (functionSlug) query = query.eq("director_function", functionSlug);

  const { data } = await query;
  const rows = (data ?? []) as ActivityRow[];
  if (!rows.length) return { date, scope, directors: [], empty: true };

  // Bucket by director, preserving first-seen order (already newest-first overall).
  const bySlug = new Map<string, ActivityRow[]>();
  for (const r of rows) {
    const arr = bySlug.get(r.director_function) ?? [];
    arr.push(r);
    bySlug.set(r.director_function, arr);
  }
  const directors = Array.from(bySlug.entries()).map(([slug, rs]) => narrateDirector(slug, rs));
  return { date, scope, directors, empty: directors.length === 0 };
}

interface GenerateRecapResult {
  ok: boolean;
  reason?: string;
  date?: string;
  directorsPosted?: number;
  ceoPosted?: boolean;
}

/**
 * Generate the EOD recap for a workspace + date (UTC). Aggregates the day's activity per director,
 * posts a `recap` board message + an `agent_daily_summary` notification for each ACTIVE director, then
 * a CEO roll-up. Idempotent per (workspace, date, author): a recap already posted today is skipped, so
 * a cron retry never double-posts. Returns `{ ok:false, reason:'no_activity' }` for a quiet workspace.
 */
export async function generateDirectorRecap(workspaceId: string, date: string): Promise<GenerateRecapResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: "bad_date_format" };

  const admin = createAdminClient();
  const dayStart = new Date(date + "T00:00:00.000Z").toISOString();
  const dayEnd = new Date(new Date(date + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000).toISOString();

  const [{ specs }, functions] = await Promise.all([getRoadmap(), getFunctions()]);

  // Seed a zeroed entry for every known director — we only ever attribute to a real function.
  const byFn: DirectorRecapMap = {};
  for (const fn of functions) byFn[fn.slug] = emptyStats();

  // spec slug → owner function (live specs only — a folded spec leaves specs/, a display proxy like XP).
  const ownerBySpec = new Map<string, string>();
  for (const s of specs) if (s.owner) ownerBySpec.set(s.slug, s.owner);

  // 1. specsShipped — builds that merged today, owned by the function (updated_at = the merge flip).
  const { data: merged } = await admin
    .from("agent_jobs")
    .select("spec_slug")
    .eq("workspace_id", workspaceId)
    .eq("kind", "build")
    .eq("status", "merged")
    .gte("updated_at", dayStart)
    .lt("updated_at", dayEnd);
  for (const row of (merged ?? []) as { spec_slug: string | null }[]) {
    const owner = row.spec_slug ? ownerBySpec.get(row.spec_slug) : undefined;
    if (owner && byFn[owner]) byFn[owner].specsShipped++;
  }

  // 2. approvals — approved decisions today, split into bugs (repair/regression) · migrations · other.
  const { data: approvals } = await admin
    .from("approval_decisions")
    .select("agent_job_id, raised_by_function")
    .eq("workspace_id", workspaceId)
    .eq("decision", "approved")
    .gte("created_at", dayStart)
    .lt("created_at", dayEnd);
  const approvalRows = (approvals ?? []) as { agent_job_id: string | null; raised_by_function: string }[];
  const jobIds = [...new Set(approvalRows.map((r) => r.agent_job_id).filter((id): id is string => !!id))];
  const jobKind = new Map<string, string>();
  if (jobIds.length) {
    const { data: jobs } = await admin.from("agent_jobs").select("id, kind").in("id", jobIds);
    for (const j of (jobs ?? []) as { id: string; kind: string }[]) jobKind.set(j.id, j.kind);
  }
  for (const r of approvalRows) {
    const stats = byFn[r.raised_by_function];
    if (!stats) continue;
    stats.approvalsHandled++;
    const kind = r.agent_job_id ? jobKind.get(r.agent_job_id) : undefined;
    if (kind && FIX_JOB_KINDS.has(kind)) stats.bugsFixed++;
    else if (kind && MIGRATION_JOB_KINDS.has(kind)) stats.migrationsApproved++;
  }

  // 3. director_activity — total actions today + goal-advance slice (milestones advanced = M4's job).
  const { data: activity } = await admin
    .from("director_activity")
    .select("director_function, action_kind")
    .eq("workspace_id", workspaceId)
    .gte("created_at", dayStart)
    .lt("created_at", dayEnd);
  for (const a of (activity ?? []) as { director_function: string; action_kind: string }[]) {
    const stats = byFn[a.director_function];
    if (!stats) continue;
    stats.actions++;
    if (GOAL_ADVANCE_KINDS.has(a.action_kind)) stats.goalsAdvanced++;
  }

  // Active directors only — no empty standup spam for a director who did nothing today.
  const activeSlugs = functions.map((f) => f.slug).filter((slug) => isActive(byFn[slug]));
  if (!activeSlugs.length) return { ok: false, reason: "no_activity", date, directorsPosted: 0, ceoPosted: false };

  // Idempotency: skip any author whose recap for this date already landed (cron retry safe).
  const { data: existing } = await admin
    .from("director_messages")
    .select("author, author_function")
    .eq("workspace_id", workspaceId)
    .eq("kind", "recap")
    .eq("metadata->>recap_date", date);
  const postedDirectors = new Set<string>();
  let ceoPosted = false;
  for (const e of (existing ?? []) as { author: string; author_function: string | null }[]) {
    if (e.author === "ceo") ceoPosted = true;
    else if (e.author === "director" && e.author_function) postedDirectors.add(e.author_function);
  }

  // Phase 3 (platform-scorecard-surface) — the scorecard one-liner the Platform director's recap row
  // carries. Read once (the trended store, never the raw tables); null when no KPI is persisted yet.
  const scorecardLine = activeSlugs.includes(PLATFORM_FUNCTION)
    ? composeScorecardWatchLine(await loadLatestScorecardSnapshots(admin, workspaceId))
    : null;

  // Per-director recap → board `recap` post + Daily Summaries notification.
  let directorsPosted = 0;
  for (const slug of activeSlugs) {
    if (postedDirectors.has(slug)) continue;
    const stats = byFn[slug];
    const persona = getPersona(slug);
    const recapBody = composeDirectorRecap(slug, stats);
    // The Platform recap row also carries the scorecard headline + deep-links the Daily Summaries
    // row to /dashboard/agents/scorecard (platform-scorecard-surface Phase 3). Other directors still
    // deep-link to the day narrative (director-loop-grading Phase 5).
    const isPlatform = slug === PLATFORM_FUNCTION;
    const summaryBody = isPlatform && scorecardLine ? `${recapBody} ${scorecardLine}.` : recapBody;
    const summaryLink = isPlatform
      ? `/dashboard/agents/scorecard`
      : `/dashboard/agents/recap/${date}?function=${encodeURIComponent(slug)}`;
    await postDirectorMessage({
      workspaceId,
      author: "director",
      authorFunction: slug,
      body: summaryBody,
      kind: "recap",
      metadata: { recap_date: date, source: "eod-recap", stats, ...(isPlatform && scorecardLine ? { scorecard_line: scorecardLine } : {}) },
    });
    await insertDailySummary(admin, {
      workspaceId,
      title: `${persona.name} · ${persona.role} — daily recap`,
      body: summaryBody,
      link: summaryLink,
      metadata: {
        recap_date: date,
        source: "eod-recap",
        author_function: slug,
        stats,
        ...(isPlatform ? { scorecard_link: "/dashboard/agents/scorecard" } : {}),
        ...(isPlatform && scorecardLine ? { scorecard_line: scorecardLine } : {}),
      },
    });
    directorsPosted++;
  }

  // CEO roll-up — the company standup across every active director.
  if (!ceoPosted) {
    const total = emptyStats();
    for (const slug of activeSlugs) {
      const s = byFn[slug];
      total.specsShipped += s.specsShipped;
      total.goalsAdvanced += s.goalsAdvanced;
      total.bugsFixed += s.bugsFixed;
      total.migrationsApproved += s.migrationsApproved;
      total.approvalsHandled += s.approvalsHandled;
      total.actions += s.actions;
    }
    const body = composeCeoRollup(total, activeSlugs.length);
    await postDirectorMessage({
      workspaceId,
      author: "ceo",
      body,
      kind: "recap",
      metadata: { recap_date: date, source: "eod-recap", scope: "ceo-rollup", stats: total },
    });
    await insertDailySummary(admin, {
      workspaceId,
      title: `Company standup — ${date}`,
      body,
      // The CEO roll-up links to the cross-director day narrative (no `function` → every active director).
      link: `/dashboard/agents/recap/${date}`,
      metadata: { recap_date: date, source: "eod-recap", scope: "ceo-rollup", stats: total },
    });
    ceoPosted = true;
  }

  return { ok: true, date, directorsPosted, ceoPosted };
}

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Read the latest snapshot per (metric_key, cadence) from `platform_scorecard_snapshots` for the
 * Platform director's recap one-liner ([[../specs/platform-scorecard-surface]] Phase 3). Best-effort;
 * on read error returns empty groups so the recap simply omits the scorecard line — never a fake number.
 */
async function loadLatestScorecardSnapshots(
  admin: Admin,
  workspaceId: string,
): Promise<Record<ScorecardCadence, ScorecardSnapshotLite[]>> {
  const empty: Record<ScorecardCadence, ScorecardSnapshotLite[]> = { daily: [], weekly: [], monthly: [] };
  try {
    const { data } = await admin
      .from("platform_scorecard_snapshots")
      .select("metric_key, cadence, snapshot_date, value, delta_pct, unit")
      .eq("workspace_id", workspaceId)
      .order("snapshot_date", { ascending: false })
      .limit(2000);
    const rows = (data ?? []) as Array<{
      metric_key: string;
      cadence: string;
      snapshot_date: string;
      value: number | string;
      delta_pct: number | string | null;
      unit: string;
    }>;
    const seen = new Set<string>();
    for (const r of rows) {
      const cadence = r.cadence as ScorecardCadence;
      if (cadence !== "daily" && cadence !== "weekly" && cadence !== "monthly") continue;
      const key = `${cadence}::${r.metric_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const value = typeof r.value === "number" ? r.value : Number(r.value);
      const deltaRaw = r.delta_pct;
      const deltaPct = deltaRaw == null ? null : typeof deltaRaw === "number" ? deltaRaw : Number(deltaRaw);
      empty[cadence].push({
        metric_key: r.metric_key,
        value: Number.isFinite(value) ? value : 0,
        delta_pct: deltaPct != null && Number.isFinite(deltaPct) ? deltaPct : null,
        unit: r.unit,
      });
    }
  } catch {
    /* best-effort — empty groups → no scorecard line */
  }
  return empty;
}

/** Surface a recap in the M1 Daily Summaries tab — a reserved `agent_daily_summary` notification. */
async function insertDailySummary(
  admin: Admin,
  input: { workspaceId: string; title: string; body: string; link?: string; metadata: Record<string, unknown> },
): Promise<void> {
  await admin.from("dashboard_notifications").insert({
    workspace_id: input.workspaceId,
    type: DAILY_SUMMARY_TYPE,
    title: input.title,
    body: input.body,
    // the row's deep-link to the human-readable day narrative (Phase 5); the inbox renders title+body as a link.
    link: input.link ?? null,
    metadata: input.metadata,
    read: false,
    dismissed: false,
  });
}
