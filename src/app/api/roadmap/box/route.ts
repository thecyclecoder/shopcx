/**
 * GET /api/roadmap/box — live build-box view (build-box-status-view).
 *
 * Returns the singleton worker_heartbeats row (enriched with the lane picture: build_lanes /
 * fold_lanes totals + a `lanes` array of what each in-flight lane is building) plus this
 * workspace's open agent_jobs split into queue-depth (waiting) and paused (needs_input /
 * needs_approval) — so /dashboard/roadmap/box can answer "is the box healthy / busy / behind?"
 * without SSH. Read-only; box infra is global so the heartbeat isn't workspace-scoped.
 *
 * See docs/brain/tables/worker_heartbeats.md + docs/brain/dashboard/roadmap.md.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRoadmap } from "@/lib/brain-roadmap";
import type { SessionChecklistItem } from "@/lib/agent-jobs";
import {
  CLAUDE_PREVIEW_IGNORE_COMMAND,
  getProjectIgnoreState,
} from "@/lib/vercel-project";
import { selectLatestBuildBySlug } from "@/lib/box-failed-supersede";

// preview-test-promote-pipeline M1 Phase 3 — the Vercel Ignored-Build-Step override state, surfaced
// on the build console so the supervisor can SEE that `claude/*` preview builds are enabled. Cached
// at module scope (60s TTL) so the box's 5-second poll doesn't hammer the Vercel API. A missing
// token / network failure / API error returns { status: "unknown" } — never throws — so the box
// page still renders.
type PreviewOverride = {
  status: "enabled" | "drifted" | "unknown";
  expected: string;
  actual: string | null;
  reason: string | null;
  fetched_at: string | null;
};

const PREVIEW_OVERRIDE_TTL_MS = 60_000;
let cachedPreviewOverride: PreviewOverride | null = null;
let cachedPreviewOverrideAt = 0;

async function getPreviewOverrideState(): Promise<PreviewOverride> {
  const now = Date.now();
  if (cachedPreviewOverride && now - cachedPreviewOverrideAt < PREVIEW_OVERRIDE_TTL_MS) {
    return cachedPreviewOverride;
  }
  if (!process.env.VERCEL_API_TOKEN && !process.env.VERCEL_TOKEN) {
    const v: PreviewOverride = {
      status: "unknown",
      expected: CLAUDE_PREVIEW_IGNORE_COMMAND,
      actual: null,
      reason: "VERCEL_API_TOKEN not set",
      fetched_at: new Date(now).toISOString(),
    };
    cachedPreviewOverride = v;
    cachedPreviewOverrideAt = now;
    return v;
  }
  try {
    const { commandForIgnoringBuildStep } = await getProjectIgnoreState();
    const v: PreviewOverride = {
      status: commandForIgnoringBuildStep === CLAUDE_PREVIEW_IGNORE_COMMAND ? "enabled" : "drifted",
      expected: CLAUDE_PREVIEW_IGNORE_COMMAND,
      actual: commandForIgnoringBuildStep,
      reason: null,
      fetched_at: new Date(now).toISOString(),
    };
    cachedPreviewOverride = v;
    cachedPreviewOverrideAt = now;
    return v;
  } catch (e) {
    const v: PreviewOverride = {
      status: "unknown",
      expected: CLAUDE_PREVIEW_IGNORE_COMMAND,
      actual: null,
      reason: e instanceof Error ? e.message.slice(0, 200) : "fetch failed",
      fetched_at: new Date(now).toISOString(),
    };
    cachedPreviewOverride = v;
    cachedPreviewOverrideAt = now;
    return v;
  }
}


interface LaneRow {
  kind: string;
  job_id: string;
  spec_slug: string;
  since: string;
  // Which phase a chained/per-phase build is on (e.g. "Phase 2"); null for a whole-spec or non-build
  // lane (box-lane-show-phase). Written by the worker's heartbeat; passed through as-is.
  phase?: string | null;
  // For a director-coach lane only: the turn's intent (ask|coach), enriched from the job instructions
  // below so the box shows "Asking Ada" vs "Coaching Ada" by which button the CEO pushed.
  intent?: string | null;
  // box-grading-session-and-account-count-fixes Phase 3 — the acting director's function slug for a
  // grade/coach lane (platform→Ada, ceo→Henry, growth→Cleo), enriched from the job below so the box shows
  // "Ada Grading" / "Henry Grading" instead of a generic label + default mascot.
  director_function?: string | null;
  // box-session-transparency Phase 2 — the lane's live TodoWrite mirror, enriched from the agent_jobs
  // row below so a lane card can show what its session is doing RIGHT NOW (compact: the one-line note;
  // expand: the full checklist). Phase 1's runner writes both onto the row; Phase 2 surfaces them here.
  session_note?: string | null;
  session_checklist?: SessionChecklistItem[] | null;
  // consolidate-premerge-checks-one-session Phase 2 — true for a `spec-test` lane whose underlying
  // agent_jobs row is a PRE-MERGE fused session (spec_branch starts with `claude/`). The box view renders
  // TWO personas (Vera + Vault) + a static 'spec-test · security' label for these, because one session
  // emits both verdicts; a NON-fused spec-test lane (post-ship, no branch) still renders single-persona.
  fused_pre_merge?: boolean;
  // chained-phase-session-resume Phase 2 — true when this lane's job carried a `claude_session_id` at
  // claim (a chained-phase resume from the prior phase's session, OR a needs_input/needs_approval →
  // queued_resume flip). Written by the box worker's heartbeat; passed through as-is so the lane card
  // can render a `resumed`/`fresh` indicator (cache-warm vs cache-cold). Undefined on legacy rows.
  resumed?: boolean;
}

// Per-account Max load + cap/failover events (box-multi-account-failover Phase 2). Written by the worker's
// heartbeat as a single jsonb blob; passed through as-is so the box-health view can show how each account's
// 5-hour quota is burning + an all-capped state.
interface AccountsSnapshot {
  pool: { label: string; in_flight: number; capped: boolean; capped_until: string | null }[];
  healthy: number;
  total: number;
  all_capped: boolean;
  soonest_reset: string | null;
  events: { at: string; type: string; account: string; detail: string }[];
}

// build-box-page-reflects-real-per-lane-group-usage Phase 2 — per-lane-group cap map, written by the
// box worker's heartbeat as a single jsonb blob. Each entry is a NAMED lane group (build_plan /
// customer_service / director / fold / other) with its OWN cap and the set of `agent_jobs.kind`
// values that count against it. The page + BoxChip render each group against its OWN cap by
// filtering worker.lanes on the group's kind-set, so the "13/10 in use" nonsense the pre-existing
// build_lanes/fold_lanes scalar caps produced can't recur. NULL for legacy heartbeat rows written
// before the column existed — the page falls back to build_lanes/fold_lanes then.
interface LaneGroups {
  [group: string]: { cap: number; kinds: string[] };
}

/**
 * Pull the human-readable failure reason out of a job's log_tail. A `claude -p` run stores its
 * result JSON (`{is_error, api_error_status, result}`) — surface the 529 / Max-limit / API message
 * so the owner can tell a transient overload from a real bug. A tsc failure stores raw compiler
 * output — show its tail. Never throws; returns null when there's nothing useful.
 */
function failureDetail(logTail: string | null): string | null {
  if (!logTail) return null;
  try {
    const j = JSON.parse(logTail);
    if (j && typeof j === "object") {
      const parts: string[] = [];
      if (j.api_error_status) parts.push(`API ${j.api_error_status}`);
      if (typeof j.result === "string" && j.result.trim()) parts.push(j.result.trim());
      else if (typeof j.subtype === "string" && j.is_error) parts.push(j.subtype);
      if (parts.length) return parts.join(" — ").slice(0, 500);
    }
  } catch {
    /* not JSON (e.g. tsc output) — fall through to the tail */
  }
  return logTail.slice(-500).trim() || null;
}

// box-grading-session-and-account-count-fixes Phase 3 — the acting director's function slug for a grade/
// coach lane. Prefer the `fn` the enqueue stamped on the job (dynamic), else a per-kind default. Returns
// null for any non-grade/coach kind (the box page then falls back to its normal persona resolution).
const GRADE_COACH_DEFAULT_FN: Record<string, string> = {
  "agent-grade": "platform", // Ada grades platform workers
  "agent-coach": "platform",
  "director-grade": "ceo", // the CEO (Henry) grades directors
  "campaign-grade": "growth", // Cleo grades storefront campaigns
  "gap-grade": "growth", // Cleo grades acquisition gaps
};
function directorFunctionForGradeKind(kind: string, instructions: string | null): string | null {
  if (!(kind in GRADE_COACH_DEFAULT_FN)) return null;
  try {
    const i = JSON.parse(instructions || "{}");
    if (typeof i.fn === "string" && i.fn.trim()) return i.fn.trim();
  } catch {
    /* not JSON — fall through to the per-kind default */
  }
  return GRADE_COACH_DEFAULT_FN[kind];
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: hb } = await admin
    .from("worker_heartbeats")
    .select("running_sha, status, active_builds, detail, last_poll_at, started_at, build_lanes, fold_lanes, lane_groups, lanes, accounts")
    .eq("id", "box")
    .maybeSingle();
  // Queue-restart drain state (worker_controls) — so the box page can show "draining" + toggle it.
  const { data: ctrl } = await admin
    .from("worker_controls")
    .select("drain_for_update, requested_at_sha, requested_by, requested_at")
    .eq("box_id", "box")
    .maybeSingle();
  const drain = {
    draining: !!ctrl?.drain_for_update,
    requested_at_sha: (ctrl?.requested_at_sha as string | null) ?? null,
    requested_by: (ctrl?.requested_by as string | null) ?? null,
    requested_at: (ctrl?.requested_at as string | null) ?? null,
  };
  const worker = hb
    ? {
        running_sha: hb.running_sha as string | null,
        status: hb.status as string,
        active_builds: hb.active_builds as number,
        detail: hb.detail as string | null,
        last_poll_at: hb.last_poll_at as string | null,
        started_at: hb.started_at as string | null,
        build_lanes: (hb.build_lanes as number | null) ?? 0,
        fold_lanes: (hb.fold_lanes as number | null) ?? 0,
        // build-box-page-reflects-real-per-lane-group-usage Phase 2 — pass the per-group cap map
        // through so the page + BoxChip render each lane group against its OWN cap (kind-set) from
        // this single source of truth instead of hardcoding MAX_* in the UI. NULL for legacy rows
        // written before the column existed (the page then falls back to build_lanes/fold_lanes).
        lane_groups: (hb.lane_groups as LaneGroups | null) ?? null,
        lanes: (hb.lanes as LaneRow[] | null) ?? [],
        // accounts is `{}` until the worker first writes a snapshot; normalize to null so the UI shows
        // nothing (rather than an empty grid) on a single-account / legacy box.
        accounts: (hb.accounts && (hb.accounts as AccountsSnapshot).pool ? (hb.accounts as AccountsSnapshot) : null),
      }
    : null;

  // Enrich director-coach lanes with their turn intent (ask|coach) from the job instructions, so the box
  // can render "Asking Ada" vs "Coaching Ada" by which button the CEO pushed.
  if (worker?.lanes?.length) {
    const coachIds = worker.lanes.filter((l) => l.kind === "director-coach" && l.job_id).map((l) => l.job_id);
    if (coachIds.length) {
      const { data: cj } = await admin.from("agent_jobs").select("id, instructions").in("id", coachIds);
      const intentById = new Map<string, string>();
      for (const j of (cj || []) as Array<{ id: string; instructions: string | null }>) {
        try {
          const i = JSON.parse(j.instructions || "{}");
          if (i.intent) intentById.set(j.id, String(i.intent));
        } catch {
          /* not JSON */
        }
      }
      worker.lanes = worker.lanes.map((l) => (l.kind === "director-coach" && intentById.has(l.job_id) ? { ...l, intent: intentById.get(l.job_id) ?? null } : l));
    }
  }

  // box-grading-session-and-account-count-fixes Phase 3 — enrich each grade/coach lane with its ACTING
  // director's function slug (from the job's `instructions.fn`, else the per-kind default), so the box card
  // renders "Ada Grading" / "Henry Grading" / "Cleo Grading" instead of a generic label + default mascot.
  if (worker?.lanes?.length) {
    const gcIds = worker.lanes.filter((l) => l.job_id && directorFunctionForGradeKind(l.kind, null) !== null).map((l) => l.job_id);
    if (gcIds.length) {
      const { data: gj } = await admin.from("agent_jobs").select("id, kind, instructions").in("id", gcIds);
      const fnById = new Map<string, string | null>();
      for (const j of (gj || []) as Array<{ id: string; kind: string; instructions: string | null }>) {
        fnById.set(j.id, directorFunctionForGradeKind(j.kind, j.instructions));
      }
      worker.lanes = worker.lanes.map((l) => (fnById.has(l.job_id) ? { ...l, director_function: fnById.get(l.job_id) ?? null } : l));
    }
  }

  // box-session-transparency Phase 2 — enrich every lane with the active session's live TodoWrite mirror
  // (session_checklist + session_note) the runner streams onto its agent_jobs row, so each lane card can
  // un-black-box what the session is doing right now. Same enrichment shape as the director-coach intent
  // above. Best-effort: a missing row / NULL columns just leave the lane unenriched.
  if (worker?.lanes?.length) {
    const ids = worker.lanes.map((l) => l.job_id).filter(Boolean);
    if (ids.length) {
      const { data: cl } = await admin
        .from("agent_jobs")
        .select("id, session_checklist, session_note")
        .in("id", ids);
      const checklistById = new Map<string, SessionChecklistItem[] | null>();
      const noteById = new Map<string, string | null>();
      for (const j of (cl || []) as Array<{ id: string; session_checklist: SessionChecklistItem[] | null; session_note: string | null }>) {
        checklistById.set(j.id, j.session_checklist ?? null);
        noteById.set(j.id, j.session_note ?? null);
      }
      worker.lanes = worker.lanes.map((l) =>
        checklistById.has(l.job_id) || noteById.has(l.job_id)
          ? { ...l, session_checklist: checklistById.get(l.job_id) ?? null, session_note: noteById.get(l.job_id) ?? null }
          : l,
      );
    }
  }

  // consolidate-premerge-checks-one-session Phase 2 — mark each `spec-test` lane whose job carries a
  // `claude/*` `spec_branch` as fused_pre_merge (one session, two verdicts). The box card then renders
  // BOTH Vera (spec-test) + Vault (security) avatars + a 'spec-test · security' label. A spec-test job
  // without a claude/* branch is post-ship (single-persona; unchanged).
  if (worker?.lanes?.length) {
    const stIds = worker.lanes.filter((l) => l.kind === "spec-test" && l.job_id).map((l) => l.job_id);
    if (stIds.length) {
      const { data: st } = await admin.from("agent_jobs").select("id, spec_branch").in("id", stIds);
      const fusedById = new Map<string, boolean>();
      for (const j of (st || []) as Array<{ id: string; spec_branch: string | null }>) {
        fusedById.set(j.id, !!(j.spec_branch && j.spec_branch.startsWith("claude/")));
      }
      worker.lanes = worker.lanes.map((l) => (fusedById.has(l.job_id) ? { ...l, fused_pre_merge: fusedById.get(l.job_id) ?? false } : l));
    }
  }

  // Open jobs (live, actionable layer) for queue depth + paused callouts. `instructions` is pulled so the
  // queued-jobs log (below) can parse the per-job "Phase N" the worker was handed. `spec_branch` is pulled
  // so a queued spec-test job for a claude/* branch renders as fused pre-merge (Vera + Vault) too.
  const { data: jobsData } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, kind, status, pr_url, pr_number, created_at, instructions, spec_branch")
    .eq("workspace_id", workspaceId)
    .in("status", ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume"])
    .order("created_at", { ascending: true });
  const jobs = (jobsData ?? []) as {
    id: string;
    spec_slug: string;
    kind: string;
    status: string;
    pr_url: string | null;
    pr_number: number | null;
    created_at: string;
    instructions: string | null;
    spec_branch: string | null;
  }[];

  // fold-guard-live-build (Phase 1) — defense in depth: a build/spec-test job whose spec page no longer
  // exists (the spec was folded → archived/deleted) must never render as a dead link. Compute the set of
  // LIVE (non-archived) spec slugs; the page routes a job with `spec_missing` to a safe target instead of
  // the would-be-404 /dashboard/roadmap/{slug}. Best-effort — a roadmap-read failure just leaves it false.
  let liveSpecSlugs = new Set<string>();
  // slug → its next-unshipped phase index (1-based), the fallback phase when a queued job's instructions
  // don't carry a "Phase N" of their own (queued-jobs-log). Undefined = the spec is fully shipped / unknown.
  const nextPhaseBySlug = new Map<string, number>();
  try {
    const { specs } = await getRoadmap();
    liveSpecSlugs = new Set(specs.map((s) => s.slug));
    for (const s of specs) {
      const idx = s.phases.findIndex((p) => p.status !== "shipped");
      if (idx >= 0) nextPhaseBySlug.set(s.slug, idx + 1);
    }
  } catch {
    /* roadmap read failed — leave spec_missing false (no worse than today) */
  }
  // Only build-kind slugs are supposed to resolve to a spec page; non-build kinds already route elsewhere
  // (approvalHref), so a missing spec only matters for them.
  const specMissing = (kind: string, slug: string): boolean =>
    (kind === "build" || kind === "spec-test") && !liveSpecSlugs.has(slug);

  // Derive a queued job's PHASE: prefer the "Phase N" the worker was handed in its instructions (a chained
  // per-phase build carries this); fall back to the spec's next-unshipped phase. Null when neither resolves
  // (one-shot spec / non-build kind / fully-shipped). `instructions` may be plain text or a JSON blob — try
  // both. Returns a display string like "Phase 2".
  const phaseForJob = (kind: string, slug: string, instructions: string | null): string | null => {
    if (instructions) {
      // The raw instructions string, or a `.prompt`/`.instructions` field if it's a JSON envelope.
      let text = instructions;
      try {
        const j = JSON.parse(instructions);
        if (j && typeof j === "object") text = String(j.prompt ?? j.instructions ?? instructions);
      } catch {
        /* plain text — use as-is */
      }
      const m = text.match(/\bPhase\s+(\d+)\b/i);
      if (m) return `Phase ${m[1]}`;
    }
    const next = nextPhaseBySlug.get(slug);
    return next ? `Phase ${next}` : null;
  };

  // Waiting = not yet in a lane; paused = needs owner action. The queue carries the avatar-log fields
  // (kind, spec_slug, derived phase) the box page renders as the "Jobs in queue" feed.
  const queue = jobs
    .filter((j) => j.status === "queued" || j.status === "queued_resume")
    .map((j) => ({
      id: j.id,
      spec_slug: j.spec_slug,
      kind: j.kind,
      status: j.status,
      pr_url: j.pr_url,
      pr_number: j.pr_number,
      created_at: j.created_at,
      phase: phaseForJob(j.kind, j.spec_slug, j.instructions),
      spec_missing: specMissing(j.kind, j.spec_slug),
      director_function: directorFunctionForGradeKind(j.kind, j.instructions),
      // consolidate-premerge-checks-one-session Phase 2 — a queued spec-test job targeting a `claude/*`
      // branch is a fused pre-merge session (Vera + Vault); the queued-jobs log renders both personas.
      fused_pre_merge: j.kind === "spec-test" && !!(j.spec_branch && j.spec_branch.startsWith("claude/")),
    }));
  const paused = jobs
    .filter((j) => j.status === "needs_input" || j.status === "needs_approval")
    .map((j) => ({ ...j, spec_missing: specMissing(j.kind, j.spec_slug) }));

  // Failed builds (actionable) — surface a failure so the owner doesn't have to dig into a spec
  // card to learn a build died. Only show a spec whose latest attempt is `failed` UNDER OUTCOME
  // PRECEDENCE (box-failed-build-supersede-and-dismiss Phase 1): a terminal success (merged /
  // completed) or an in-flight build (building / queued) supersedes an older failure — AND
  // supersedes a later-created failure too, so the 2026-07-02 case (a long build that started
  // 06:09 and merged 08:50 was masked by a quick failed attempt created 08:41) doesn't recur.
  // See `selectLatestBuildBySlug` for the ranking.
  const { data: buildHist } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, kind, status, error, log_tail, updated_at, created_at")
    .eq("workspace_id", workspaceId)
    .in("kind", ["build", "plan"])
    .order("created_at", { ascending: false })
    .limit(500);
  type BuildJob = { id: string; spec_slug: string; kind: string; status: string; error: string | null; log_tail: string | null; updated_at: string; created_at: string };
  const latestBySlug = selectLatestBuildBySlug((buildHist ?? []) as BuildJob[]);
  const failed = [...latestBySlug.values()]
    .filter((j) => j.status === "failed")
    .map((j) => ({ id: j.id, spec_slug: j.spec_slug, kind: j.kind, error: j.error ?? null, detail: failureDetail(j.log_tail), updated_at: j.updated_at, spec_missing: specMissing(j.kind, j.spec_slug) }))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, 20);

  // preview-test-promote-pipeline M1 Phase 3 — the Vercel Ignored-Build-Step override state. Cached
  // 60s; never throws (best-effort). Surfaced as a chip on /dashboard/roadmap/box so the supervisor
  // can see the override is in place without running the apply script (supervisable autonomy).
  const preview_build_override = await getPreviewOverrideState();

  return NextResponse.json({ worker, queue, paused, failed, drain, preview_build_override });
}
