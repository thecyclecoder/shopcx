/**
 * regression-agent — the queue plumbing + autonomy policy behind the **Regression Agent box worker**
 * ([[docs/brain/specs/regression-agent.md]]). A worker the Platform/DevOps Director supervises that
 * does exactly what the operator did by hand: **review each regression and either dismiss it or author
 * a fix spec** — then the DevOps Director queues the build (within its leash).
 *
 * A "regression" is a thing that USED TO WORK and now doesn't (distinct from a brand-new error — those
 * stay with the [[repair-agent]]). Phase 1's concrete detector is **spec-test-✅-now-failing**: a spec
 * marked ✅ shipped whose spec_phase_checks rows no longer hold (an evidence-backed `fail` check on its
 * latest [[spec_test_runs]] run — a false-✅ / drift caught by [[../specs/spec-test-deep-verification]]).
 *
 * North star (supervisable autonomy): the agent **authors + dismisses** (a bounded proxy — "is this a
 * real regression + here's the fix"); the **DevOps Director (objective owner) queues the build** and is
 * graded on whether the fix held. More autonomous than the repair agent — it SKIPS the "propose" step
 * and authors the fix spec DIRECTLY (the regression is a confirmed break, not a hypothesis to pitch) —
 * but it still never builds/merges on its own. A repeatedly-failing fix → loop-guard escalates to CEO.
 *
 * Two entry points (event-driven — there is NO regression cron; a spec-test run flipping a ✅ spec to a
 * `fail` IS the trigger):
 *   - `enqueueRegressionJob` — called the moment the box's spec-test agent records a regression on a
 *     shipped spec (inline at the end of `runSpecTestJob`). Deduped by the regression SIGNATURE
 *     (spec_slug + the set of failing check keys) — one review per distinct break; a dismissed break
 *     never re-surfaces.
 *   - the box worker's `runRegressionJob` (scripts/builder-worker.ts) consumes the queue.
 */
import { createHash } from "crypto";
import type { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

/** The verdict the box reaches per regression (it cites what regressed for each). */
export type RegressionVerdict =
  | "real-regression" // a genuine break of prior-working behaviour → author a fix spec DIRECTLY, route to inbox.
  | "transient" // a deploy-boundary flap / momentary blip that already recovered → dismiss, record why.
  | "foreign" // the failing check is foreign noise / not a real regression of our behaviour → dismiss.
  | "false-positive" // the spec-test check itself mis-fired (the feature is fine) → dismiss, record why.
  | "already-fixed" // a fix already shipped / is in-flight (pending deploy / re-test) → dismiss, record why.
  | "needs-human"; // can't confidently review → surface "needs human", no spec, no loop.

/** The dismiss verdicts: a regression reviewed away with recorded reasoning, no fix spec authored. */
export const REGRESSION_DISMISS_VERDICTS: ReadonlySet<string> = new Set(["transient", "foreign", "false-positive", "already-fixed"]);

/**
 * The verdicts that permanently BLOCK re-surface of the same break (dedup): a genuine "not a real
 * regression" call. `already-fixed` is deliberately EXCLUDED — it's a transient "a fix is in-flight,
 * pending deploy" state, so the same break MUST be allowed to re-fire if that fix doesn't hold (the
 * loop-guard then counts the real re-attempts).
 */
export const REGRESSION_NO_RESURFACE_VERDICTS: ReadonlySet<string> = new Set(["transient", "foreign", "false-positive"]);

/** The function whose objective owns this worker — the Platform/DevOps Director supervises it. */
export const REGRESSION_DIRECTOR_FUNCTION = "platform";

/** Loop-guard: a regression fix that fails to HOLD after this many authored attempts → escalate to CEO
 *  (a deeper issue), never infinite re-author. */
export const REGRESSION_LOOP_GUARD_MAX = 2;

/** The window over which the loop-guard counts prior authored attempts + a dismissal blocks re-surface. */
export const REGRESSION_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Statuses that mean a regression job for a signature is still "live" (being worked or surfaced). */
export const LIVE_REGRESSION_STATUSES = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "needs_attention"];

/** One failing spec_phase_checks row the spec-test agent observed breaking (evidence-backed). */
export interface RegressionFailing {
  text: string;
  evidence?: string;
  check_key: string;
}

/**
 * A stable regression SIGNATURE = spec slug + the SET of failing check keys (sorted, hashed). Two runs
 * of the same spec that fail the SAME checks share one signature (one review, no re-surface); a NEW
 * failing check on the same spec is a distinct signature (a genuinely new break gets its own review).
 */
export function regressionSignature(specSlug: string, failingKeys: string[]): string {
  const keys = [...new Set(failingKeys.map((k) => String(k || "").trim()).filter(Boolean))].sort();
  const h = createHash("sha1").update(keys.join("|")).digest("hex").slice(0, 12);
  return `regression:${specSlug}:${h}`;
}

/** Shape of a regression job's `instructions` JSON — the brief the box loads to review the break. */
export interface RegressionInstructions {
  signature: string;
  spec_slug: string;
  title: string;
  failing: RegressionFailing[];
  run_at: string;
  /** set on a TERMINAL job by the box: the verdict it reached (dismiss verdicts block re-surface). */
  verdict?: string;
  /** set when the box authored a fix: the slug it wrote (the loop-guard attempt ledger reads this). */
  authored_slug?: string;
}

export interface EnqueueRegressionInput {
  workspaceId: string;
  specSlug: string;
  /** the spec's human-readable title (for the surfaced item). */
  title: string;
  /** the evidence-backed failing checks from the latest spec_test run (the regression). */
  failing: RegressionFailing[];
  /** the spec-test run timestamp this regression was observed at. */
  runAt: string;
}

/**
 * Enqueue a `regression` agent job for a NEW regression on a shipped spec. Best-effort + idempotent:
 *   - no-op if a regression job for this SIGNATURE is already live (don't double-review the same break),
 *   - no-op if a recent terminal regression job for this signature was DISMISSED (no re-surface — the
 *     operator/agent already reviewed this exact break away).
 * An authored-but-not-held fix does NOT block: the same break re-firing flows back in so `runRegressionJob`'s
 * loop-guard can count the attempt and escalate at `REGRESSION_LOOP_GUARD_MAX`. Never throws.
 */
export async function enqueueRegressionJob(admin: Admin, input: EnqueueRegressionInput): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    const failing = (input.failing || []).filter((f) => f && f.check_key);
    if (failing.length === 0) return { enqueued: false, reason: "no evidence-backed failing checks" };
    const signature = regressionSignature(input.specSlug, failing.map((f) => f.check_key));

    // Dedup 1 — a live review for this exact break already exists.
    const { data: live } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("kind", "regression")
      .eq("spec_slug", signature)
      .in("status", LIVE_REGRESSION_STATUSES)
      .limit(1)
      .maybeSingle();
    if (live) return { enqueued: false, reason: "live regression job exists for this signature" };

    // Dedup 2 — this exact break was already reviewed away (dismissed). No re-surface.
    const sinceIso = new Date(Date.now() - REGRESSION_RECENT_WINDOW_MS).toISOString();
    const { data: priors } = await admin
      .from("agent_jobs")
      .select("instructions, status")
      .eq("kind", "regression")
      .eq("spec_slug", signature)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(10);
    for (const p of (priors ?? []) as Array<{ instructions?: string }>) {
      try {
        const instr = JSON.parse(String(p.instructions || "{}")) as RegressionInstructions;
        if (instr.verdict && REGRESSION_NO_RESURFACE_VERDICTS.has(instr.verdict)) {
          return { enqueued: false, reason: `signature already dismissed (${instr.verdict}) — no re-surface` };
        }
      } catch {
        /* not JSON — ignore */
      }
    }

    const instructions: RegressionInstructions = {
      signature,
      spec_slug: input.specSlug,
      title: input.title.slice(0, 300),
      failing: failing.map((f) => ({ text: f.text, evidence: f.evidence, check_key: f.check_key })),
      run_at: input.runAt,
    };
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: input.workspaceId,
      spec_slug: signature,
      kind: "regression",
      status: "queued",
      instructions: JSON.stringify(instructions),
    });
    if (error) {
      console.warn(`[regression-agent] enqueue failed for ${signature}:`, error.message);
      return { enqueued: false, reason: error.message };
    }
    // DETECT — the first of the three audited actions (detect → dismiss | author). Best-effort.
    await recordDirectorActivity(admin, {
      workspaceId: input.workspaceId,
      directorFunction: REGRESSION_DIRECTOR_FUNCTION,
      actionKind: "detected_regression",
      specSlug: input.specSlug,
      reason: `Regression detected on shipped spec ${input.specSlug}: ${failing.length} verification check(s) now fail (${failing.map((f) => f.text).join("; ")}).`.slice(0, 4000),
      metadata: { signature, failing: failing.map((f) => ({ text: f.text, check_key: f.check_key })), run_at: input.runAt },
    });
    return { enqueued: true, reason: signature };
  } catch (err) {
    console.warn("[regression-agent] enqueueRegressionJob threw:", err instanceof Error ? err.message : err);
    return { enqueued: false, reason: "threw" };
  }
}

/**
 * Loop-guard ledger: how many prior authored fix attempts exist for THIS spec within the window (any
 * signature — a fix that didn't hold re-fires under the same OR a shifted failing set). At
 * `REGRESSION_LOOP_GUARD_MAX` the box escalates to CEO instead of re-authoring. Excludes the calling job.
 */
export async function regressionAuthoredAttempts(admin: Admin, specSlug: string, selfJobId: string): Promise<number> {
  const sinceIso = new Date(Date.now() - REGRESSION_RECENT_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("agent_jobs")
    .select("id, instructions")
    .eq("kind", "regression")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });
  let n = 0;
  for (const r of (data ?? []) as Array<{ id: string; instructions?: string }>) {
    if (r.id === selfJobId) continue;
    try {
      const instr = JSON.parse(String(r.instructions || "{}")) as RegressionInstructions;
      if (instr.spec_slug === specSlug && instr.authored_slug) n++;
    } catch {
      /* not JSON — skip */
    }
  }
  return n;
}

// ── Dashboard surface (read-only) ────────────────────────────────────────────
// A regression job surfaces while it waits on the disposer: `needs_approval` (a fix spec authored +
// routed to the inbox, awaiting the director/CEO's queue-the-build) or `needs_attention` (a needs-human
// review, or a loop-guard escalation — no auto path). Dismissed + auto-queued jobs complete silently.

export interface RegressionSurfaceItem {
  jobId: string;
  /** the regression signature this job reviews. */
  signature: string;
  /** the spec that regressed. */
  specSlug: string;
  /** short label of the regressed spec. */
  title: string;
  /** the box's plain-text review + what regressed. */
  review: string;
  /** the authored fix spec slug (set for a routed fix; null for needs-human / escalation). */
  fixSlug: string | null;
  /** 'routed' = a fix spec is authored + awaiting the queue-the-build; 'needs-human' = no spec. */
  state: "routed" | "needs-human";
  createdAt: string;
}

/**
 * READ-ONLY: the open regression items awaiting the disposer (director/CEO). Surfaced regression jobs
 * are those in `needs_approval` (a routed fix) or `needs_attention` (needs-human / escalation). The
 * auto-queued (director-leash) + dismissed jobs complete silently and never appear here.
 */
export async function getOpenRegressions(admin: Admin, workspaceId: string): Promise<RegressionSurfaceItem[]> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, instructions, pending_actions, log_tail, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "regression")
    .in("status", ["needs_approval", "needs_attention"])
    .order("created_at", { ascending: false })
    .limit(50);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    let title = String(row.spec_slug || "");
    let specSlug = "";
    try {
      const instr = JSON.parse(String(row.instructions || "{}")) as RegressionInstructions;
      if (instr.title) title = String(instr.title);
      specSlug = String(instr.spec_slug || "");
    } catch {
      /* instructions not JSON — fall back to the signature */
    }
    const actions = Array.isArray(row.pending_actions) ? (row.pending_actions as Array<Record<string, unknown>>) : [];
    const buildAction = actions.find((a) => a.type === "regression_build" && a.status === "pending");
    const fixSlug = buildAction ? String(buildAction.spec_slug || "") || null : null;
    return {
      jobId: String(row.id),
      signature: String(row.spec_slug || ""),
      specSlug,
      title,
      review: typeof row.log_tail === "string" ? row.log_tail : "",
      fixSlug,
      state: row.status === "needs_approval" && fixSlug ? "routed" : "needs-human",
      createdAt: String(row.created_at || ""),
    };
  });
}
