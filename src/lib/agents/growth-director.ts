/**
 * Growth Director agent (growth-director-agent spec, Phases 1–2) — the SECOND live director, after Ada.
 *
 * North star (operational-rules § supervisable autonomy): CEO → Director → tool. The Growth tools
 * (iteration policies, storefront optimizer, Meta creative actions, ad-spend reallocation, ad-publish)
 * already work; nobody SUPERVISES them as a director. This module mirrors `platform-director`:
 *   - Phase 1 — the LEASH_CATEGORIES union, the per-action leash gate, `growthIsAutoApprover`.
 *   - Phase 2 — `buildGrowthDirectorBrief` (read-only loader of the Growth control surfaces — function
 *     autonomy row + the iteration_policies version ledger + the storefront_optimizer_policy row + the
 *     open iteration_recommendations) + `growthDirectorInvestigationPrompt` (the Max `claude -p`
 *     prompt wrapped with `directorLiveStateFact(admin,'growth')` so the verdict is premised on the
 *     LIVE flag, never on stale brain prose). The session emits ONE JSON verdict `auto-approve|escalate`.
 *   - Phase 3 adds the enqueuer + applyDirectorApproval + box-worker wiring.
 *
 * Build-driving stays with Ada permanently (CEO directive 2026-06-29) — Growth OPERATES its software,
 * never builds.
 *
 * Activation is owner-confirmed and lands later (M6 flag flip): until `function_autonomy('growth')` is
 * `live + autonomous`, `reconcileApprovalInbox` never stamps `routed_to_function='growth'`, so the
 * enqueuer (Phase 3) is a no-op — the machinery is built but dormant.
 *
 * See docs/brain/specs/growth-director-agent.md · docs/brain/libraries/platform-director.md.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { isAutoApprover, type AutonomyMap } from "@/lib/agents/approval-router";
import { directorLiveStateFact } from "@/lib/agents/platform-director";

type Admin = ReturnType<typeof createAdminClient>;

/** The Growth director's function slug — the DRI this director embodies. */
export const GROWTH = "growth";

// ── The leash (the spec § Phase 1) ───────────────────────────────────────────────────────────────
// What the Growth director MAY auto-approve. A structural gate (which action class) plus — enforced
// by the runner's read-only investigation in Phase 2 — a soundness gate ("never rubber-stamps").
// Anything outside this, and anything destructive/irreversible/budget-ceiling-breaking, ALWAYS
// escalates to the CEO.
export type LeashCategory =
  | "iteration_policy_activation"
  | "storefront_optimizer_policy_activation"
  | "pause_underperforming_creative"
  | "reallocate_within_ceiling"
  | "promote_ready_to_test_creative";

export const LEASH_CATEGORIES: LeashCategory[] = [
  "iteration_policy_activation",
  "storefront_optimizer_policy_activation",
  "pause_underperforming_creative",
  "reallocate_within_ceiling",
  "promote_ready_to_test_creative",
];

/**
 * The pending-action types that are UNCONDITIONALLY leash candidates → their leash category. Each must
 * still pass the read-only investigation verdict (the soundness gate added in Phase 2). The mapping is
 * 1:1 with the categories — Growth's pending-action `type` fields are named the same as the leash
 * categories themselves, so no separate adapter is needed.
 *
 * Anything not in this map — including any non-binary CHOICE action (e.g. a multi-option budget
 * reallocation choice) — falls out of leash and escalates to the CEO.
 */
const LEASH_ACTION_TYPES: Record<string, LeashCategory> = {
  iteration_policy_activation: "iteration_policy_activation",
  storefront_optimizer_policy_activation: "storefront_optimizer_policy_activation",
  pause_underperforming_creative: "pause_underperforming_creative",
  reallocate_within_ceiling: "reallocate_within_ceiling",
  promote_ready_to_test_creative: "promote_ready_to_test_creative",
};

/** A loosely-typed agent_jobs row as the worker/enqueuer reads it (Supabase returns untyped JSON). */
export interface DirectorActionLike {
  id?: string;
  type?: string;
  status?: string;
  summary?: string;
  preview?: string;
  cmd?: string;
}
export interface DirectorTargetJob {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string | null;
  status?: string;
  pending_actions: DirectorActionLike[] | null;
  log_tail?: string | null;
}

/** True iff Growth is the live + autonomous auto-approver (so requests route here). */
export function growthIsAutoApprover(autonomy: AutonomyMap): boolean {
  return isAutoApprover(GROWTH, autonomy);
}

/** One in-leash pending action the director may consider — its id + the leash class it falls into. */
export interface LeashAction {
  actionId: string;
  category: LeashCategory;
}

/** The still-pending actions on a target (default status 'pending' when absent) — what the gate decides on. */
function pendingTargetActions(job: DirectorTargetJob): DirectorActionLike[] {
  return (job.pending_actions || []).filter((a) => (a.status ?? "pending") === "pending" && a.id);
}

/**
 * The leash class for ONE pending action, or null (out of leash). Mapped via LEASH_ACTION_TYPES;
 * everything else (including unknown types and any multi-choice action) is out of leash.
 */
function categoryFor(action: DirectorActionLike): LeashCategory | null {
  const type = action.type;
  if (!type) return null;
  return LEASH_ACTION_TYPES[type] ?? null;
}

/**
 * The leash gate. Returns EVERY pending action the director may auto-approve, with its leash class,
 * plus a verdict:
 *   - `none`   — empty, OR ANY pending action is out of leash. A bundle is ALL-OR-NOTHING: one
 *                out-of-leash action escalates the whole request.
 *   - `single` — exactly one in-leash action.
 *   - `multi`  — a bundle where EVERY action is in-leash (e.g. activate an iteration policy + flip
 *                the storefront-optimizer policy as one approval). Approved atomically; the Phase-2
 *                soundness gate still confirms the bundle is reversible.
 * Mirrors `platform-director` `directorLeashCandidates`.
 */
export function directorLeashCandidates(job: DirectorTargetJob): { actions: LeashAction[]; verdict: "none" | "single" | "multi" } {
  const pending = pendingTargetActions(job);
  if (!pending.length) return { actions: [], verdict: "none" };
  const actions: LeashAction[] = [];
  for (const a of pending) {
    const category = categoryFor(a);
    if (!category) return { actions: [], verdict: "none" }; // one out-of-leash action ⇒ escalate the whole bundle
    actions.push({ actionId: a.id as string, category });
  }
  return { actions, verdict: actions.length === 1 ? "single" : "multi" };
}

// ── Phase 2 — read-only brief + investigation prompt ─────────────────────────────────────────────
// The brief loads the Growth control surfaces the investigation reads aloud:
//   - function_autonomy('growth') — the LIVE flag (the same DB row directorLiveStateFact wraps the
//     prompt with). Sourced via `loadAutonomyMap` per spec; missing row ⇒ off (fail-safe).
//   - iteration_policies — the versioned policy ledger for the workspace + each version's status (the
//     `active` row is what the ad engine reads; `pending` rows are awaiting director activation; the
//     director must be able to see what was active before approving a new activation).
//   - storefront_optimizer_policy — the single-row optimizer gate for the workspace (on/off, scope,
//     auto_run_reversible) — what flipping `active` actually affects.
//   - iteration_recommendations — the open `pending` recommendation queue (so the director sees the
//     spend lines an approval will unlock or change).
// The brief itself is data only; the prompt is the wrap (with directorLiveStateFact prepended).
// `loadAutonomyMap` creates its own admin client internally — we read function_autonomy directly via
// the passed admin to keep this testable + keep one connection per call.

/** One row of public.iteration_policies the brief carries — the legibility fields the director reads. */
export interface IterationPolicySummary {
  id: string;
  version: number;
  status: "pending" | "active" | "superseded" | string;
  created_by: string | null;
  rationale: string | null;
  activated_at: string | null;
  superseded_at: string | null;
  created_at: string | null;
}

/** The current single-row optimizer policy for the workspace (the surface a policy-activation flips). */
export interface StorefrontOptimizerPolicySummary {
  id: string;
  active: boolean;
  product_scope: unknown;
  auto_run_reversible: boolean;
  rationale: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

/** One open `pending` recommendation row — the spend lines the optimizer/Meta engine want to open. */
export interface IterationRecommendationSummary {
  id: string;
  action_type: string;
  title: string | null;
  rationale: string | null;
  persona: string | null;
  status: string;
  created_at: string | null;
}

/** One in-leash action inside the brief — what the investigation confirms is sound. */
export interface GrowthDirectorBriefAction {
  category: LeashCategory;
  summary: string;
  preview: string;
  cmd: string;
}

/** The read-only brief the Growth director investigates — the request + the loaded control surfaces. */
export interface GrowthDirectorBrief {
  jobId: string;
  workspaceId: string;
  kind: string;
  specSlug: string | null;
  /** every leash class in the request (one for single, ≥2 for a bundle). */
  categories: LeashCategory[];
  /** each in-leash action's summary/preview/cmd, in bundle order. */
  actions: GrowthDirectorBriefAction[];
  /** true when the request bundles >1 action (approved atomically, all-or-nothing). */
  multi: boolean;
  /** the growth row from function_autonomy (null when unreadable / missing). */
  growthAutonomy: { live: boolean; autonomous: boolean } | null;
  /** the latest N iteration_policies versions for the workspace, status included (newest first). */
  iterationPolicies: IterationPolicySummary[];
  /** the single optimizer-policy row for the workspace (null when none exists yet). */
  storefrontOptimizerPolicy: StorefrontOptimizerPolicySummary | null;
  /** the open `status='pending'` iteration_recommendations rows for the workspace (newest first). */
  pendingRecommendations: IterationRecommendationSummary[];
  logTail: string;
}

/** How many iteration_policies versions + pending recommendations the brief carries — cap the prompt size. */
const POLICY_VERSIONS_CAP = 8;
const PENDING_RECOS_CAP = 25;

/**
 * Load the Growth director's brief — every loader is best-effort + returns the empty/null shape on
 * failure, so a transient read error never blocks the investigation (the prompt then notes the gap).
 */
export async function buildGrowthDirectorBrief(
  admin: Admin,
  job: DirectorTargetJob,
  candidates: LeashAction[],
): Promise<GrowthDirectorBrief> {
  const actions: GrowthDirectorBriefAction[] = candidates.map((c) => {
    const a = (job.pending_actions || []).find((p) => p.id === c.actionId) ?? {};
    return { category: c.category, summary: a.summary || "", preview: a.preview || "", cmd: a.cmd || "" };
  });

  // function_autonomy('growth') — the same DB row directorLiveStateFact wraps; we load it INTO the brief
  // so any down-stream caller (logging, the disposition lane) can see the flag without a second read.
  let growthAutonomy: GrowthDirectorBrief["growthAutonomy"] = null;
  try {
    const { data } = await admin
      .from("function_autonomy")
      .select("live, autonomous")
      .eq("function_slug", GROWTH)
      .maybeSingle();
    if (data) growthAutonomy = { live: !!data.live, autonomous: !!data.autonomous };
  } catch {
    /* best-effort — prompt narrates the gap */
  }

  // The versioned policy ledger — newest first. We carry the `pending` + `active` versions explicitly
  // (the verification asserts the brief includes both), bounded by POLICY_VERSIONS_CAP so a long ledger
  // doesn't blow up the prompt.
  let iterationPolicies: IterationPolicySummary[] = [];
  try {
    const { data } = await admin
      .from("iteration_policies")
      .select("id, version, status, created_by, rationale, activated_at, superseded_at, created_at")
      .eq("workspace_id", job.workspace_id)
      .order("version", { ascending: false })
      .limit(POLICY_VERSIONS_CAP);
    iterationPolicies = ((data || []) as IterationPolicySummary[]).map((r) => ({
      id: r.id,
      version: r.version,
      status: r.status,
      created_by: r.created_by ?? null,
      rationale: r.rationale ?? null,
      activated_at: r.activated_at ?? null,
      superseded_at: r.superseded_at ?? null,
      created_at: r.created_at ?? null,
    }));
  } catch {
    /* best-effort */
  }

  // The single-row optimizer policy for the workspace — what flipping `active` actually toggles.
  let storefrontOptimizerPolicy: StorefrontOptimizerPolicySummary | null = null;
  try {
    const { data } = await admin
      .from("storefront_optimizer_policy")
      .select("id, active, product_scope, auto_run_reversible, rationale, updated_by, updated_at")
      .eq("workspace_id", job.workspace_id)
      .maybeSingle();
    if (data) {
      storefrontOptimizerPolicy = {
        id: data.id,
        active: !!data.active,
        product_scope: data.product_scope ?? [],
        auto_run_reversible: !!data.auto_run_reversible,
        rationale: data.rationale ?? null,
        updated_by: data.updated_by ?? null,
        updated_at: data.updated_at ?? null,
      };
    }
  } catch {
    /* best-effort */
  }

  // The open `status='pending'` recommendations — the spend lines this approval could unlock or change.
  let pendingRecommendations: IterationRecommendationSummary[] = [];
  try {
    const { data } = await admin
      .from("iteration_recommendations")
      .select("id, action_type, title, rationale, persona, status, created_at")
      .eq("workspace_id", job.workspace_id)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(PENDING_RECOS_CAP);
    pendingRecommendations = ((data || []) as IterationRecommendationSummary[]).map((r) => ({
      id: r.id,
      action_type: r.action_type,
      title: r.title ?? null,
      rationale: r.rationale ?? null,
      persona: r.persona ?? null,
      status: r.status,
      created_at: r.created_at ?? null,
    }));
  } catch {
    /* best-effort */
  }

  return {
    jobId: job.id,
    workspaceId: job.workspace_id,
    kind: job.kind,
    specSlug: job.spec_slug,
    categories: candidates.map((c) => c.category),
    actions,
    multi: actions.length > 1,
    growthAutonomy,
    iterationPolicies,
    storefrontOptimizerPolicy,
    pendingRecommendations,
    logTail: (job.log_tail || "").slice(-2000),
  };
}

/** Render the iteration_policies ledger inside the prompt — compact, newest-first. */
function renderIterationPolicies(rows: IterationPolicySummary[]): string {
  if (!rows.length) return "iteration_policies: (no versions yet — the ad engine is fully idle until a director or human activates v1)";
  const lines = rows.map(
    (r) =>
      `  - v${r.version} · status=${r.status} · created_by=${r.created_by ?? "?"}${r.activated_at ? ` · activated ${r.activated_at}` : ""}${r.superseded_at ? ` · superseded ${r.superseded_at}` : ""}${r.rationale ? ` — ${r.rationale.slice(0, 200)}` : ""}`,
  );
  return ["iteration_policies (newest first):", ...lines].join("\n");
}

/** Render the storefront_optimizer_policy row inside the prompt — the single source of truth. */
function renderOptimizerPolicy(p: StorefrontOptimizerPolicySummary | null): string {
  if (!p) return "storefront_optimizer_policy: (no row — the optimizer is fully idle, propose-gate refuses everything)";
  const scope = Array.isArray(p.product_scope) ? p.product_scope.join(", ") : JSON.stringify(p.product_scope ?? []);
  return [
    "storefront_optimizer_policy:",
    `  - active=${p.active} · auto_run_reversible=${p.auto_run_reversible}`,
    `  - product_scope: [${scope}]`,
    p.rationale ? `  - rationale: ${p.rationale.slice(0, 300)}` : "",
    p.updated_at ? `  - last updated ${p.updated_at}${p.updated_by ? ` by ${p.updated_by}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Render the pending recommendation queue inside the prompt — what the engines want to open. */
function renderPendingRecommendations(rows: IterationRecommendationSummary[]): string {
  if (!rows.length) return "iteration_recommendations (status=pending): (none — no open recommendations on the queue)";
  const lines = rows.map(
    (r) => `  - [${r.action_type}${r.persona ? ` · ${r.persona}` : ""}] ${r.title ?? "(no title)"}${r.rationale ? ` — ${r.rationale.slice(0, 200)}` : ""}`,
  );
  return ["iteration_recommendations (status=pending, newest first):", ...lines].join("\n");
}

/**
 * The Max `claude -p` investigation prompt — read-only diagnose → one JSON verdict.
 *
 * Wrapped with `directorLiveStateFact(admin,'growth')` (the same DB row the runtime guards gate on)
 * so the verdict is premised on the LIVE flag, never on a stale brain page that still narrates
 * "dormant" or "not yet live" (brain-platform-live-autonomous-status Phase 2 — the recurrence guard
 * applied to Growth). The verdict is binary `auto-approve|escalate` — Growth's pending-action types
 * are policy/budget/creative flips that either pass the soundness gate (auto-approve) or don't
 * (escalate); there is no `bounce` lane (that is Platform's repair-spec quality-bounce).
 */
export async function growthDirectorInvestigationPrompt(admin: Admin, brief: GrowthDirectorBrief): Promise<string> {
  const liveState = await directorLiveStateFact(admin, GROWTH);

  const actionBlock = brief.actions
    .map((a, i) => {
      const head = brief.multi
        ? `Action ${i + 1} — category=${a.category}:`
        : `This request — category=${a.category}, kind=${brief.kind}, spec=${brief.specSlug ?? "—"}:`;
      return [
        head,
        `  summary: ${a.summary}`,
        a.preview ? `  proposed fix / preview:\n${a.preview}` : "",
        a.cmd ? `  command that runs on approval: ${a.cmd}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const bundleRule = brief.multi
    ? [
        `This Approval Request BUNDLES ${brief.actions.length} actions that run together (kind=${brief.kind}, spec=${brief.specSlug ?? "—"}) — e.g. activate an iteration policy version + flip the storefront optimizer policy as one atomic approval.`,
        "Decide ALL-OR-NOTHING: AUTO-APPROVE only if EVERY action is sound + within the leash AND the bundle is REVERSIBLE as a whole. If ANY single action is destructive, irreversible, out of leash, or unconfirmable, ESCALATE the WHOLE request. Never partial-approve.",
      ].join("\n")
    : "Investigate the cause + the proposed action and decide.";

  return [
    liveState,
    "",
    "You are the Growth Director for ShopCX, running on Max (read-only prod DB + the brain, no API key).",
    "A growth tool you supervise (the storefront optimizer, the ad engine, Meta creative adapter, or the ad-spend rail)",
    "raised an Approval Request that routed to YOU. Your job: investigate READ-ONLY, then decide — AUTO-APPROVE only",
    "if it is SOUND, LOW-RISK, and WITHIN THE LEASH; otherwise ESCALATE to the CEO. NEVER rubber-stamp: if you",
    "cannot confirm it is sound and in-leash, escalate.",
    "",
    "The leash — you MAY auto-approve ONLY these classes:",
    "- iteration_policy_activation: authoring/activating a versioned iteration_policies row — a typed,",
    "  reversible policy edit (activation supersedes the prior `active` row; the engine reads it read-only).",
    "- storefront_optimizer_policy_activation: flipping `storefront_optimizer_policy.active` for an allowlisted",
    "  product — a reversible on/off the next pass re-reads.",
    "- pause_underperforming_creative: a Meta creative status flip via the existing iteration_actions `pause`",
    "  adapter — reversible (the same adapter unpauses).",
    "- reallocate_within_ceiling: a budget reallocation that stays WITHIN an active ad_spend_budgets ceiling",
    "  (no ceiling-breaking deltas; the active ceiling is the hard rail).",
    "- promote_ready_to_test_creative: approving a creative INTO the ad_publish_jobs PAUSED flow (the publisher",
    "  writes meta ids back PAUSED — never goes live without a second approve).",
    "",
    "ALWAYS ESCALATE (never auto-approve): anything destructive or irreversible, a budget ceiling change /",
    "ceiling-breaking spend delta, a non-binary CHOICE action, modifying or abandoning an approved goal,",
    "starting a NEW goal, or anything you cannot confirm is sound.",
    "",
    bundleRule,
    "",
    "## Current Growth control surfaces (loaded read-only into the brief)",
    `workspace_id: ${brief.workspaceId}`,
    `function_autonomy('growth'): ${brief.growthAutonomy ? `live=${brief.growthAutonomy.live}, autonomous=${brief.growthAutonomy.autonomous}` : "UNKNOWN (read failed — treat as off)"}`,
    "",
    renderIterationPolicies(brief.iterationPolicies),
    "",
    renderOptimizerPolicy(brief.storefrontOptimizerPolicy),
    "",
    renderPendingRecommendations(brief.pendingRecommendations),
    "",
    "## The request under investigation",
    actionBlock,
    brief.logTail ? `\ninvestigation log so far:\n${brief.logTail}` : "",
    "",
    "Investigate read-only (the implicated policy version SQL, the optimizer policy row, the recommendation rationale,",
    "the creative/spend lines this touches). Confirm every action is sound, reversible, and within the leash before approving.",
    "",
    "Final message = ONLY one JSON object:",
    '{"verdict":"auto-approve","leash_category":"iteration_policy_activation|storefront_optimizer_policy_activation|pause_underperforming_creative|reallocate_within_ceiling|promote_ready_to_test_creative","reasoning":"<why every action is sound + low-risk + within the leash, and the bundle is reversible>"}',
    '{"verdict":"escalate","reasoning":"<why this needs the CEO — high-stakes / irreversible / unconfirmable / out of leash / a choice / a ceiling change>"}',
  ]
    .filter(Boolean)
    .join("\n");
}
