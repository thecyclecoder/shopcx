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

/** Deep-link to a director's (or the CEO's) human-readable EOD detail page (director-loop-grading Phase 5). */
export function recapDetailHref(fn: string, date: string): string {
  return `/dashboard/agents/recap/${encodeURIComponent(fn)}/${encodeURIComponent(date)}`;
}

/** The CEO company-standup roll-up across every active director (plain text, no markdown). */
export function composeCeoRollup(total: DirectorDayStats, activeDirectors: number): string {
  const ceo = getPersona("ceo");
  const tail = activeDirectors
    ? ` across ${plural(activeDirectors, "active director")}`
    : ` — a quiet day on the board`;
  return `${ceo.emoji} Company standup — ${summaryLine(total)}${tail}.`;
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
  const { byFn, functions } = await aggregateDirectorDay(admin, workspaceId, date);

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

  // Per-director recap → board `recap` post + Daily Summaries notification.
  let directorsPosted = 0;
  for (const slug of activeSlugs) {
    if (postedDirectors.has(slug)) continue;
    const stats = byFn[slug];
    const persona = getPersona(slug);
    const body = composeDirectorRecap(slug, stats);
    await postDirectorMessage({
      workspaceId,
      author: "director",
      authorFunction: slug,
      body,
      kind: "recap",
      metadata: { recap_date: date, source: "eod-recap", stats },
    });
    await insertDailySummary(admin, {
      workspaceId,
      title: `${persona.name} · ${persona.role} — daily recap`,
      body,
      // Deep-link to the human-readable detail page (director-loop-grading Phase 5) — the day narrated.
      link: recapDetailHref(slug, date),
      metadata: { recap_date: date, source: "eod-recap", author_function: slug, stats },
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
      // The CEO roll-up detail aggregates every director's day under the `ceo` scope.
      link: recapDetailHref("ceo", date),
      metadata: { recap_date: date, source: "eod-recap", scope: "ceo-rollup", stats: total },
    });
    ceoPosted = true;
  }

  return { ok: true, date, directorsPosted, ceoPosted };
}

type Admin = ReturnType<typeof createAdminClient>;

/** Surface a recap in the M1 Daily Summaries tab — a reserved `agent_daily_summary` notification. */
async function insertDailySummary(
  admin: Admin,
  input: { workspaceId: string; title: string; body: string; link?: string | null; metadata: Record<string, unknown> },
): Promise<void> {
  await admin.from("dashboard_notifications").insert({
    workspace_id: input.workspaceId,
    type: DAILY_SUMMARY_TYPE,
    title: input.title,
    body: input.body,
    link: input.link ?? null,
    metadata: input.metadata,
    read: false,
    dismissed: false,
  });
}

interface RoadmapFn {
  slug: string;
}

/**
 * Aggregate a workspace's per-director activity for `date` (UTC `[00:00, 24:00)`) from existing truth —
 * the shared substrate for both the one-line recap ([[generateDirectorRecap]]) and the human-readable
 * detail page ([[buildDirectorDayDetail]]). A pure read; never writes. Returns a zeroed map seeded for
 * every known function so attribution only ever lands on a real director.
 */
async function aggregateDirectorDay(
  admin: Admin,
  workspaceId: string,
  date: string,
): Promise<{ byFn: DirectorRecapMap; functions: RoadmapFn[] }> {
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

  return { byFn, functions };
}

// ── The human-readable EOD detail page (director-loop-grading Phase 5) ──────────────────────────────
//
// A readable narrative of the director's day — what it fixed + why, which goal it moved + how far, what
// it escalated — built by READING that day's director_activity rows (never hand-maintained). Each row's
// open-vocabulary action_kind maps to a narrative SECTION + a human verb; the row's plain-text reason is
// the "why". Deterministic (no LLM) — the same display-only-proxy stance as the one-line recap above.

type RecapSectionId = "fixed" | "goals" | "escalated" | "other";

interface RecapKindMeta {
  /** the human verb phrase for this action_kind (no spec slug — that's appended). */
  verb: string;
  section: RecapSectionId;
}

/** action_kind → { verb, section }. Open vocabulary: an unknown kind falls back to a humanized "other". */
const KIND_META: Record<string, RecapKindMeta> = {
  detected_regression: { verb: "Detected a regression", section: "fixed" },
  dismissed_regression: { verb: "Dismissed a regression", section: "fixed" },
  authored_fix: { verb: "Authored a fix", section: "fixed" },
  approved_approval: { verb: "Auto-approved a request", section: "fixed" },
  approved_migration: { verb: "Approved a migration", section: "fixed" },
  coaching_routed_to_repair: { verb: "Routed coaching to a repair", section: "fixed" },
  escorted_goal: { verb: "Escorted a goal", section: "goals" },
  advanced_milestone: { verb: "Advanced a milestone", section: "goals" },
  shipped_milestone: { verb: "Shipped a milestone", section: "goals" },
  escalated: { verb: "Escalated to the CEO", section: "escalated" },
  escalated_coaching: { verb: "Escalated a coaching case", section: "escalated" },
  coached_worker: { verb: "Coached a worker", section: "other" },
  groomed_continue: { verb: "Groomed the board (continue)", section: "other" },
  groomed_split: { verb: "Groomed the board (split)", section: "other" },
};

const SECTION_TITLES: Record<RecapSectionId, string> = {
  fixed: "Fixes & approvals",
  goals: "Goals moved",
  escalated: "Escalations",
  other: "Other actions",
};
const SECTION_ORDER: RecapSectionId[] = ["fixed", "goals", "escalated", "other"];

/** Resolve an action_kind to its narrative metadata (humanizing an unknown kind into the "other" bucket). */
function kindMeta(kind: string): RecapKindMeta {
  if (KIND_META[kind]) return KIND_META[kind];
  // Heuristic fallbacks for open-vocabulary kinds the live directors add later.
  if (/escalat/i.test(kind)) return { verb: "Escalated", section: "escalated" };
  if (/goal|milestone/i.test(kind)) return { verb: humanizeKind(kind), section: "goals" };
  if (/fix|repair|approv/i.test(kind)) return { verb: humanizeKind(kind), section: "fixed" };
  return { verb: humanizeKind(kind), section: "other" };
}

/** "advanced_milestone" → "Advanced milestone" — a readable fallback verb for an unmapped kind. */
function humanizeKind(kind: string): string {
  const words = kind.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface RecapActivityLine {
  kind: string;
  /** the human verb + spec slug — "Authored a fix · migration-pin-and-item-robustness". */
  label: string;
  specSlug: string | null;
  /** the plain-text "why" the row recorded (may be empty). */
  reason: string;
  createdAt: string;
}

export interface RecapSection {
  id: RecapSectionId;
  title: string;
  lines: RecapActivityLine[];
}

export interface DirectorDayDetail {
  ok: boolean;
  reason?: string;
  date: string;
  /** the function slug, or "ceo" for the company-wide roll-up. */
  function: string;
  isCeo: boolean;
  personaName: string;
  personaRole: string;
  personaEmoji: string;
  /** the one-line standup headline (same counts as the board recap). */
  summaryLine: string;
  stats: DirectorDayStats;
  sections: RecapSection[];
  totalActions: number;
}

/**
 * Build the human-readable EOD detail for one director (or the CEO roll-up) on `date` — a pure read over
 * that day's [[director_activity]] rows grouped into narrative sections, plus the headline counts (so the
 * detail page shows both the standup line and the underlying actions). `function='ceo'` aggregates every
 * director's rows under the company roll-up. Never writes; safe to call on demand. See
 * docs/brain/libraries/director-recap.md.
 */
export async function buildDirectorDayDetail(
  workspaceId: string,
  date: string,
  functionSlug: string,
): Promise<DirectorDayDetail> {
  const isCeo = functionSlug === "ceo";
  const persona = getPersona(functionSlug);
  const base: DirectorDayDetail = {
    ok: false,
    date,
    function: functionSlug,
    isCeo,
    personaName: persona.name,
    personaRole: persona.role,
    personaEmoji: persona.emoji,
    summaryLine: "",
    stats: emptyStats(),
    sections: [],
    totalActions: 0,
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ...base, reason: "bad_date_format" };

  const admin = createAdminClient();
  const dayStart = new Date(date + "T00:00:00.000Z").toISOString();
  const dayEnd = new Date(new Date(date + "T00:00:00.000Z").getTime() + 24 * 60 * 60 * 1000).toISOString();

  // Headline counts — the CEO roll-up sums every active director; a single director takes its own slice.
  const { byFn } = await aggregateDirectorDay(admin, workspaceId, date);
  let stats = emptyStats();
  if (isCeo) {
    for (const s of Object.values(byFn)) {
      stats.specsShipped += s.specsShipped;
      stats.goalsAdvanced += s.goalsAdvanced;
      stats.bugsFixed += s.bugsFixed;
      stats.migrationsApproved += s.migrationsApproved;
      stats.approvalsHandled += s.approvalsHandled;
      stats.actions += s.actions;
    }
  } else {
    stats = byFn[functionSlug] ?? emptyStats();
  }

  // The narrative — that day's activity rows, full shape (reason + spec + when), the function's own (or all).
  let q = admin
    .from("director_activity")
    .select("director_function, action_kind, spec_slug, reason, created_at")
    .eq("workspace_id", workspaceId)
    .gte("created_at", dayStart)
    .lt("created_at", dayEnd)
    .order("created_at", { ascending: true });
  if (!isCeo) q = q.eq("director_function", functionSlug);
  const { data: rows } = await q;
  const activityRows = (rows ?? []) as {
    director_function: string;
    action_kind: string;
    spec_slug: string | null;
    reason: string | null;
    created_at: string;
  }[];

  // Group into ordered narrative sections — drop empty sections so the page reads clean.
  const bySection = new Map<RecapSectionId, RecapActivityLine[]>();
  for (const r of activityRows) {
    const meta = kindMeta(r.action_kind);
    const label = r.spec_slug ? `${meta.verb} · ${r.spec_slug}` : meta.verb;
    const line: RecapActivityLine = {
      kind: r.action_kind,
      label,
      specSlug: r.spec_slug,
      reason: (r.reason || "").trim(),
      createdAt: r.created_at,
    };
    const bucket = bySection.get(meta.section) ?? [];
    bucket.push(line);
    bySection.set(meta.section, bucket);
  }
  const sections: RecapSection[] = SECTION_ORDER.filter((id) => (bySection.get(id) ?? []).length > 0).map((id) => ({
    id,
    title: SECTION_TITLES[id],
    lines: bySection.get(id) ?? [],
  }));

  return {
    ...base,
    ok: true,
    summaryLine: summaryLine(stats),
    stats,
    sections,
    totalActions: activityRows.length,
  };
}
