/**
 * repair-agent — the queue plumbing + autonomy policy behind the **Repair Agent box agent**
 * ([[docs/brain/specs/repair-agent.md]]). "escalation-triage, but for the Control Tower."
 *
 * North star (supervisable autonomy): the Control Tower MONITOR detects problems (a new
 * error_events signature via recordError, a new loop_alert via the monitor). The repair agent is
 * the objective-owner loop ABOVE that proxy: it DIAGNOSES the root cause read-only and PROPOSES the
 * fix; the owner approves the build. The agent optimizes the bounded proxy "clear the error" — so
 * auto-spawning code builds from a noisy/flapping feed (many PRs + merge churn + cost) is the exact
 * Goodhart failure this module's policy guards against. The diagnosis + fix-spec is the high-value
 * low-risk half; *building* (writes code / opens PRs / applies migrations) stays OWNER-GATED.
 *
 * Two entry points (event-driven — there is NO repair cron; the error appearing IS the trigger):
 *   - `enqueueRepairJob` — called the moment the Control Tower records a NEW problem: inline in
 *     `recordError` (new error_events signature) and in `runControlTowerMonitor` (a newly-opened
 *     loop_alert). Deduped EXACTLY like error_events groups — one `repair` job per distinct
 *     signature; skipped if an active/surfaced repair job for that signature already exists (don't
 *     re-diagnose / re-spec the same thing).
 *   - the box worker's `runRepairJob` (scripts/builder-worker.ts) consumes the queue.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { StructuredSpecInput } from "@/lib/author-spec";
import type { SpecPhaseCheckInput, SpecPhaseCheckExecKind } from "@/lib/spec-phase-checks-table";

type Admin = ReturnType<typeof createAdminClient>;

/** The verdict the box reaches per error/alert (it cites the root cause for each). */
export type RepairVerdict =
  | "real-bug" // a genuine defect in our code → author a fix spec, SURFACE for owner Build.
  | "monitor-false-positive" // the monitor mis-flagged a healthy loop → mechanical analyzer fix.
  | "foreign-app-noise" // a foreign-app / not-ours error leaking into a feed → scope the capture.
  | "transient" // a genuine wait / transient blip → no-op + resolve the error row, never spec noise.
  | "needs-human"; // can't confidently diagnose → surface "needs human", no spec, no loop.

/**
 * surface-don't-auto-build (+ a NARROW mechanical allow-list).
 *
 * DEFAULT: the agent authors the fix spec and SURFACES it for one-tap owner Build — it does NOT
 * auto-queue the build. Only *known-safe, mechanical, self-evident* verdict classes may auto-queue
 * their build — and each entry MUST carry its justification (silence/auto is never the default).
 * Anything touching product code (`real-bug`) stays surface-and-approve, off this list.
 *
 *   - foreign-app-noise      → the fix is "scope the capture" (filter a not-ours error out of the
 *                              feed) — monitor-only, never product code.
 *   - monitor-false-positive → the fix is "add a grace / tighten the assertion" — monitor-only.
 */
export const REPAIR_AUTOBUILD_KINDS: Partial<Record<RepairVerdict, string>> = {
  "foreign-app-noise": "scope the capture — mechanical, monitor-only, never touches product code",
  "monitor-false-positive": "add a grace / tighten the assertion — mechanical, monitor-only",
};

/** Is this verdict on the sanctioned auto-queue allow-list (so its build may auto-queue)? */
export function isRepairAutobuildKind(verdict: string): boolean {
  return Object.prototype.hasOwnProperty.call(REPAIR_AUTOBUILD_KINDS, verdict);
}

// ── Dedup discipline (repair-agent-dedup Phase 1) ────────────────────────────
// The first live run over-produced: 8 specs + 6 PRs for ~3 root causes + 1 bug. Three guards harden
// it — root-cause grouping (sibling signatures → one spec), an already-fixed skip (don't re-diagnose
// a problem whose fix already shipped/is in-flight), and a per-cycle cluster cap (a burst → one
// "investigate this cluster" job, not K independent ones). The keys + constants live here; the box's
// `runRepairJob` (scripts/builder-worker.ts) wires them into the queue.

/** Beyond this many live repair jobs queued inside one burst window, fold further signatures into a
 *  single `cluster:repair` "investigate this cluster" job (they likely share one cause). K. */
export const REPAIR_CLUSTER_CAP = 5;
/** A "burst" = repair jobs queued within this window of each other (the monitor tick / error storm). */
export const REPAIR_CLUSTER_WINDOW_MS = 10 * 60 * 1000;
/** The stable spec_slug of the single batched cluster job (find-or-append, never N of them). */
export const REPAIR_CLUSTER_SLUG = "cluster:repair";
/** "Recently shipped" window for the already-fixed skip — a fix authored within this is "pending deploy". */
export const REPAIR_RECENT_FIX_WINDOW_MS = 24 * 60 * 60 * 1000; // N hours

/**
 * Normalize an implicated file path so equivalent targets compare equal: lowercase, drop a leading
 * `./` or `src/`-less prefix junk, strip a `:line[:col]` suffix and stray quoting. Empty/unknown → "".
 */
export function normalizeImplicatedFile(target?: string | null): string {
  if (!target) return "";
  let f = String(target).trim().toLowerCase();
  f = f.replace(/[`"'<>]/g, "").trim();
  f = f.replace(/^\.\//, "").replace(/^\/+/, "");
  f = f.replace(/:\d+(:\d+)?$/, ""); // a `file.ts:42` or `file.ts:42:7` suffix
  return f.trim();
}

/**
 * A stable ROOT-CAUSE key = implicated file + failure mode (verdict). Two signatures with the same
 * key are siblings of ONE root cause → they collapse onto one spec (N `Repair-signature:` lines, one
 * spec) rather than N specs. An empty target degrades to `?` so unknown-target verdicts never falsely
 * group together.
 */
export function rootCauseKey(target: string | null | undefined, verdict: string): string {
  const file = normalizeImplicatedFile(target) || "?";
  const mode = String(verdict || "").trim() || "?";
  return `${file}::${mode}`;
}

/**
 * Parse a repair-authored spec body for its machine markers: the `Repair-root-cause:` key (for
 * grouping) and every `Repair-signature:` it already carries (so we never append a dup). Used by the
 * box to decide group-onto-existing vs author-new.
 */
export function parseRepairSpecMeta(markdown: string): { rootCause: string | null; signatures: string[] } {
  const rc = markdown.match(/\*\*Repair-root-cause:\*\*\s*`([^`]+)`/);
  const signatures: string[] = [];
  const re = /\*\*Repair-signature:\*\*\s*`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    if (!signatures.includes(m[1])) signatures.push(m[1]);
  }
  return { rootCause: rc ? rc[1] : null, signatures };
}

/**
 * Statuses that mean a repair item for a signature is still "live" — either being worked
 * (active) or surfaced and awaiting the owner's Build/Dismiss (needs_approval is in the active
 * set; needs_attention is the surfaced needs-human terminal-but-uncleared state). A signature with
 * a job in any of these is NOT re-enqueued — that's the "don't re-diagnose the same thing / no
 * loop on an undiagnosable error" guard. A genuinely re-firing brand-new signature still enqueues
 * (recordError only calls us on a NEW signature, so a transient-resolved row that bumps its count
 * never re-triggers).
 */
const LIVE_REPAIR_STATUSES = ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "needs_attention"];

export interface EnqueueRepairInput {
  /** the error feed source ('inngest'|'vercel'|'supabase'|'supabase-logs'|'client') or 'loop-alert'. */
  source: string;
  /** the dedupe key — the error_events signature, or `loop:<loop_id>` for a monitor alert. */
  signature: string;
  /** short human-readable label for the surfaced item. */
  title: string;
  /** the originating error_events row (so the box loads the full sample read-only). */
  errorEventId?: string | null;
  /** the originating loop_alerts row (for a monitor-opened alert). */
  loopAlertId?: string | null;
  /** director BOUNCE feedback: when Ada found the prior authored fix UNSOUND, her explanation of WHY — the
   *  re-authoring repair pass reads this and fixes its work instead of repeating the same mistake. */
  directorFeedback?: string | null;
  /** for a `cluster:repair` re-enqueue (source==='cluster'): the batched signatures the cluster must
   *  investigate together. Persisted onto the inserted cluster job's instructions so a re-opened cluster
   *  re-triages the SAME cluster instead of an empty '0 signatures' brief. Ignored for non-cluster jobs. */
  members?: ClusterMember[];
}

/** One batched signature inside a `cluster:repair` job's `members` list. */
export interface ClusterMember {
  source: string;
  signature: string;
  title: string;
  errorEventId?: string | null;
  loopAlertId?: string | null;
}

/**
 * Resolve the workspace the repair job lands under. Errors are GLOBAL infra (not workspace-scoped),
 * and the box build queue is effectively single-tenant — so a repair job rides the SAME workspace
 * the build queue uses (the latest agent_jobs row's workspace), falling back to the first workspace.
 * Returns null only if there is no workspace at all (then the caller no-ops).
 */
async function resolveRepairWorkspace(admin: Admin): Promise<string | null> {
  const { data: latestJob } = await admin
    .from("agent_jobs")
    .select("workspace_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromJob = (latestJob as { workspace_id?: string } | null)?.workspace_id;
  if (fromJob) return fromJob;
  const { data: ws } = await admin.from("workspaces").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
  return (ws as { id?: string } | null)?.id ?? null;
}

/**
 * Enqueue a `repair` agent job for a NEW Control Tower problem. Best-effort + idempotent: no-op if a
 * repair job for this signature is already live (active or surfaced). `spec_slug` = the signature
 * (the global dedupe key, exactly like error_events groups); `instructions` = the JSON brief the box
 * loads from. Never throws — an enqueue that can crash the error path it rides is worse than the gap.
 */
export async function enqueueRepairJob(admin: Admin, input: EnqueueRepairInput): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    // Dedupe GLOBALLY by signature (errors are global infra) — skip if any live repair job exists.
    const { data: existing } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("kind", "repair")
      .eq("spec_slug", input.signature)
      .in("status", LIVE_REPAIR_STATUSES)
      .limit(1)
      .maybeSingle();
    if (existing) return { enqueued: false, reason: "live repair job exists for this signature" };

    const workspaceId = await resolveRepairWorkspace(admin);
    if (!workspaceId) return { enqueued: false, reason: "no workspace to attach the repair job to" };

    // ── Per-cycle cluster cap ──────────────────────────────────────────────
    // A burst (one monitor tick / error storm) that would spawn more than K live repair jobs likely
    // shares ONE cause — so beyond K, fold further signatures into a single `cluster:repair`
    // "investigate this cluster" job instead of N independent diagnoses. (The over-produce guard.)
    const sinceIso = new Date(Date.now() - REPAIR_CLUSTER_WINDOW_MS).toISOString();
    const { count: liveBurst } = await admin
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("kind", "repair")
      .neq("spec_slug", REPAIR_CLUSTER_SLUG)
      .in("status", LIVE_REPAIR_STATUSES)
      .gte("created_at", sinceIso);
    if ((liveBurst ?? 0) >= REPAIR_CLUSTER_CAP) {
      return foldIntoClusterJob(admin, workspaceId, input);
    }

    // When this is a re-enqueued cluster job (source==='cluster' — e.g. an owner re-open of a director-
    // dismissed `cluster:repair`), carry the batched `members` through onto the inserted job's
    // instructions. Without this the re-triage loads an empty '0 signatures' brief and wastes a pass.
    const instructions: Record<string, unknown> = {
      source: input.source,
      signature: input.signature,
      title: input.title.slice(0, 300),
      error_event_id: input.errorEventId ?? null,
      loop_alert_id: input.loopAlertId ?? null,
      director_feedback: input.directorFeedback ? input.directorFeedback.slice(0, 3000) : null,
    };
    if (input.source === "cluster") {
      instructions.members = Array.isArray(input.members) ? input.members : [];
    }
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: input.signature,
      kind: "repair",
      status: "queued",
      instructions: JSON.stringify(instructions),
    });
    if (error) {
      console.warn(`[repair-agent] enqueue failed for ${input.signature}:`, error.message);
      return { enqueued: false, reason: error.message };
    }
    return { enqueued: true };
  } catch (err) {
    console.warn("[repair-agent] enqueueRepairJob threw:", err instanceof Error ? err.message : err);
    return { enqueued: false, reason: "threw" };
  }
}

/**
 * Director BOUNCE (director-supervises-repair): Ada found the Repair agent's authored fix UNSOUND — the bug is
 * real but the fix is broken/mis-scoped/contradicted by the code. Instead of escalating to the CEO, send it
 * BACK to the Repair agent to re-do, carrying her explanation. Resolves the current repair job (so the
 * per-signature live-dedupe clears) then re-enqueues a fresh repair for the same signature with her feedback,
 * which the re-authoring pass reads. Best-effort.
 */
export async function bounceRepairToAgent(
  admin: Admin,
  input: { repairJobId: string; feedback: string },
): Promise<{ ok: boolean; reason?: string; signature?: string }> {
  try {
    // Pull the repair job's context (its signature/source/title live in instructions; spec_slug IS the signature).
    const { data: job } = await admin.from("agent_jobs").select("spec_slug, instructions").eq("id", input.repairJobId).maybeSingle();
    if (!job) return { ok: false, reason: "repair job gone" };
    let parsed: { source?: string; signature?: string; title?: string } = {};
    try {
      parsed = job.instructions ? JSON.parse(job.instructions as string) : {};
    } catch {
      /* not JSON */
    }
    const signature = parsed.signature || (job.spec_slug as string);
    const source = parsed.source || "director-bounce";
    const title = parsed.title || signature;
    // 1) Resolve the current (unsound) repair job — clears the live-dedupe so the re-enqueue isn't blocked.
    await admin
      .from("agent_jobs")
      .update({ status: "completed", log_tail: `bounced by the director — authored fix was unsound; re-authoring with feedback: ${input.feedback}`.slice(-2000) })
      .eq("id", input.repairJobId);
    // 2) Re-enqueue a fresh repair for the SAME signature, carrying Ada's why-unsound feedback.
    const r = await enqueueRepairJob(admin, { source, signature, title: `Re-fix (director bounce): ${title}`.slice(0, 300), directorFeedback: input.feedback });
    return { ok: r.enqueued, reason: r.reason, signature };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "threw" };
  }
}

/**
 * repair-verify-spec-persisted-before-build Phase 2 — escalate a `spec_row_missing` build park to a
 * SURFACE signal instead of the parked-router's silent dismissal (the fallout that hid ~16 phantom
 * repairs in the trailing 7 days).
 *
 * A build that parked `needs_attention` class=`spec_row_missing` means the fix spec never actually
 * landed in `public.specs` — the repair-agent's author path silently failed upstream (raw DB miss
 * caught + warned by `markNewSpecInReview → authorSpecRowFromMarkdown`, or a mid-write bounce),
 * `runRepairJob` still marked itself terminal (completed / needs_approval), and the build fired for
 * a slug with no row. Phase 1 closes the source-side gap by verifying-after-author (a completed
 * repair now can't slip past); this backstop covers races and pre-existing rows that already
 * shipped without the verify: the parked build must not silently dismiss out of the CEO's view.
 *
 * The escalation strategy:
 *   1) Find repair jobs originating this fix (`kind='repair'`, workspace-scoped, whose
 *      `instructions->>'authored_slug'` matches the build's `spec_slug`) whose current status is
 *      NOT already surfaced/settled — only the `completed` / `needs_approval` states, which are the
 *      "silently terminal with a phantom fix" leaks Phase 1 didn't cover. `needs_attention` /
 *      `failed` / `dismissed` are left alone (already surfaced or terminal-by-design). Flip each
 *      matched row to `needs_attention` with an actionable error via a compare-and-set
 *      (`.eq('workspace_id', …).eq('id', …).in('status', …).select('id')`) so an async-read result
 *      cannot overwrite a row that flipped under us, and stamp ONE `spec_row_missing_escalated`
 *      `director_activity` row per successful flip. `getOpenRepairs` (below) surfaces the flipped
 *      repair on the Control Tower feed as state='needs-human' (no build action attached).
 *   2) ALSO stamp ONE `spec_row_missing_escalated` `director_activity` row for the build itself
 *      whenever nothing was flipped (e.g. the fix originated in the planner / spec-chat / a
 *      migration-fix lane rather than the repair-agent, so there's no matching repair to escalate).
 *      That guarantees Ada's activity feed / Control Tower ALWAYS carries a surfaced signal for a
 *      `spec_row_missing` build — never a silent dismissal.
 *
 * Best-effort + never throws (mirrors `enqueueRepairJob`) — an audit write that crashes the caller
 * would be strictly worse than the surface gap. Callers: the claim-gate park site
 * (`scripts/builder-worker.ts` runBuildJob) fires this the moment it stamps `spec_row_missing`; the
 * parked-router (`src/lib/agents/needs-attention-route.ts` routeSpecRowMissing) fires it right
 * before dismissing the phantom build (the router still keeps 'do not build' — this only replaces
 * the SILENT dismissal with a surfaced escalation).
 */
export async function escalateSpecRowMissingBuild(
  admin: Admin,
  input: {
    workspaceId: string;
    buildJobId: string;
    slug: string | null;
    reason: string;
    /** where the escalation is fired from (audit metadata) — the immediate park at claim-time, or the parked-router. */
    source: "claim_gate_park" | "parked_router";
  },
): Promise<{ escalatedRepairIds: string[]; activityRecorded: boolean }> {
  const { workspaceId, buildJobId, slug, reason, source } = input;
  const out: { escalatedRepairIds: string[]; activityRecorded: boolean } = { escalatedRepairIds: [], activityRecorded: false };
  try {
    // 1) Find originating repair job(s) whose authored_slug matches the parked build's slug. If the
    //    parked build has no slug there's no repair to match — jump straight to the activity emit.
    if (slug) {
      // repair-verify-spec-persisted-before-build Fix 1 — `public.agent_jobs.instructions` is a
      // TEXT column (information_schema.columns.data_type='text'), so the PostgREST JSON-extraction
      // operator `.filter("instructions->>authored_slug", "eq", slug)` silently matches 0 rows and
      // NO originating repair ever surfaces. Use the text-column `ilike` precedent (the codebase's
      // proven pattern for filtering JSON-string columns — see scripts/builder-worker.ts:11958 for
      // the same shape on `dedupe_key`). `JSON.stringify` emits `"authored_slug":"value"` with no
      // whitespace, so the pattern matches every stored ledger. The candidate ceiling + the
      // compare-and-set update below narrow to the actual originating repair — a false-positive
      // text match on an unrelated field can't corrupt state (the update predicate re-asserts
      // workspace_id + expected status + .select('id')).
      const { data: candidates } = await admin
        .from("agent_jobs")
        .select("id, status, spec_slug")
        .eq("workspace_id", workspaceId)
        .eq("kind", "repair")
        .filter("instructions", "ilike", `%"authored_slug":"${slug}"%`)
        .in("status", ["completed", "needs_approval"])
        .order("created_at", { ascending: false })
        .limit(10);
      for (const r of ((candidates ?? []) as Array<{ id: string; status: string; spec_slug: string | null }>)) {
        // Compare-and-set: only flip a row that is STILL in a surfaced-terminal state — the
        // .in('status', …) predicate + workspace_id re-assertion + .select('id') round-trip mean an
        // async-read result cannot overwrite a row that flipped under us to needs_attention / failed
        // / dismissed on its own. Bail on zero rows returned (nothing transitioned).
        const escalatedError = `[repair-verify-spec-persisted-before-build P2] originating repair re-surfaced: build ${buildJobId.slice(0, 8)} parked spec_row_missing on [[${slug}]] — the fix spec never landed in public.specs; ${reason}`;
        const { data: flipped, error } = await admin
          .from("agent_jobs")
          .update({
            status: "needs_attention",
            error: escalatedError.slice(0, 2000),
            updated_at: new Date().toISOString(),
          })
          .eq("workspace_id", workspaceId)
          .eq("id", r.id)
          .in("status", ["completed", "needs_approval"])
          .select("id");
        if (error) {
          console.warn(`[repair-agent] escalateSpecRowMissingBuild flip failed for ${r.id}: ${error.message}`);
          continue;
        }
        if (!Array.isArray(flipped) || flipped.length === 0) {
          // Row already transitioned to a different state (needs_attention / failed / dismissed) —
          // don't disturb it; and don't stamp a per-repair activity row if nothing actually flipped.
          continue;
        }
        out.escalatedRepairIds.push(r.id);
        // Per-repair audit line — the same shape Ada's other spec-slug activity rows use.
        try {
          const { recordDirectorActivity } = await import("./director-activity");
          await recordDirectorActivity(admin, {
            workspaceId,
            directorFunction: "platform",
            actionKind: "spec_row_missing_escalated",
            specSlug: slug,
            reason: escalatedError,
            metadata: {
              build_job_id: buildJobId,
              repair_job_id: r.id,
              prior_repair_status: r.status,
              slug,
              source,
              autonomous: true,
            },
          });
          out.activityRecorded = true;
        } catch (e) {
          console.warn(`[repair-agent] escalateSpecRowMissingBuild activity write threw for repair ${r.id}:`, e instanceof Error ? e.message : e);
        }
      }
    }
    // 2) Nothing flipped (no repair matched, or all matches had already transitioned) — still stamp
    //    ONE build-scoped activity row so Ada's feed / the Control Tower carries a surface signal
    //    for this spec_row_missing park. That is the invariant Phase 2 owns: escalate instead of
    //    silently dismiss.
    if (!out.activityRecorded) {
      try {
        const { recordDirectorActivity } = await import("./director-activity");
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: "platform",
          actionKind: "spec_row_missing_escalated",
          specSlug: slug,
          reason: `build ${buildJobId.slice(0, 8)} parked spec_row_missing on [[${slug ?? "(no slug)"}]] and no originating repair matched to re-surface — the fix spec never landed in public.specs. ${reason}`.slice(0, 2000),
          metadata: {
            build_job_id: buildJobId,
            slug,
            source,
            no_matching_repair: true,
            autonomous: true,
          },
        });
        out.activityRecorded = true;
      } catch (e) {
        console.warn("[repair-agent] escalateSpecRowMissingBuild fallback activity write threw:", e instanceof Error ? e.message : e);
      }
    }
  } catch (err) {
    console.warn("[repair-agent] escalateSpecRowMissingBuild threw:", err instanceof Error ? err.message : err);
  }
  return out;
}

/** Shape of a `cluster:repair` job's `instructions` JSON — the batched list of signatures the box
 *  must investigate together. */
interface ClusterInstructions {
  source: "cluster";
  signature: string; // == REPAIR_CLUSTER_SLUG, the dedupe key
  title: string;
  members: ClusterMember[];
}

/**
 * Cluster-cap overflow: find-or-append into the SINGLE live `cluster:repair` job rather than spawning
 * another per-signature job. If a live cluster job exists, append this signature to its `members`
 * (deduped); else open one seeded with this signature. One cluster job per burst, never K.
 */
async function foldIntoClusterJob(admin: Admin, workspaceId: string, input: EnqueueRepairInput): Promise<{ enqueued: boolean; reason?: string }> {
  const member = {
    source: input.source,
    signature: input.signature,
    title: input.title.slice(0, 300),
    errorEventId: input.errorEventId ?? null,
    loopAlertId: input.loopAlertId ?? null,
  };
  const { data: cluster } = await admin
    .from("agent_jobs")
    .select("id, instructions")
    .eq("kind", "repair")
    .eq("spec_slug", REPAIR_CLUSTER_SLUG)
    .in("status", LIVE_REPAIR_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cluster) {
    let instr: ClusterInstructions;
    try {
      instr = JSON.parse(String((cluster as { instructions?: string }).instructions || "{}")) as ClusterInstructions;
    } catch {
      instr = { source: "cluster", signature: REPAIR_CLUSTER_SLUG, title: "Repair cluster", members: [] };
    }
    const members = Array.isArray(instr.members) ? instr.members : [];
    if (members.some((m) => m.signature === input.signature)) {
      return { enqueued: false, reason: "signature already in the live cluster" };
    }
    members.push(member);
    const { error } = await admin
      .from("agent_jobs")
      .update({
        instructions: JSON.stringify({ ...instr, source: "cluster", signature: REPAIR_CLUSTER_SLUG, title: `Repair cluster (${members.length} signatures)`, members }),
        updated_at: new Date().toISOString(),
      })
      .eq("id", (cluster as { id: string }).id);
    if (error) return { enqueued: false, reason: error.message };
    return { enqueued: true, reason: `folded into cluster job (${members.length} signatures)` };
  }

  const seed: ClusterInstructions = { source: "cluster", signature: REPAIR_CLUSTER_SLUG, title: "Repair cluster (1 signature)", members: [member] };
  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: REPAIR_CLUSTER_SLUG,
    kind: "repair",
    status: "queued",
    instructions: JSON.stringify(seed),
  });
  if (error) return { enqueued: false, reason: error.message };
  return { enqueued: true, reason: "opened cluster job" };
}

// ── Dashboard surface (read-only) ────────────────────────────────────────────
// The Control Tower's "Repair feed" tile: error X → proposed fix [[spec Y]] · [Build] [Dismiss]
// (mirrors escalation-triage — proposes, owner finalizes). A repair job surfaces while it waits on
// the owner: `needs_approval` (a proposed fix spec, with a Build button) or `needs_attention` (a
// needs-human verdict, no spec — Dismiss only).

export interface RepairSurfaceItem {
  jobId: string;
  /** the error_events signature / loop:<id> this repair addresses. */
  signature: string;
  /** short label of the originating error/alert. */
  title: string;
  /** the box's plain-text verdict + root-cause diagnosis. */
  diagnosis: string;
  /** the authored fix spec slug (set for a proposed-fix item; null for needs-human). */
  specSlug: string | null;
  /** 'proposed' = a fix spec is authored + awaiting Build; 'needs-human' = no spec, Dismiss only. */
  state: "proposed" | "needs-human";
  createdAt: string;
}

/**
 * READ-ONLY: the open repair items awaiting the owner on the Control Tower. Surfaced repair jobs are
 * those in `needs_approval` (a proposed fix spec) or `needs_attention` (a needs-human verdict). The
 * auto-queued (allow-listed) and transient-resolved jobs complete silently and never appear here.
 */
export async function getOpenRepairs(admin: Admin, workspaceId: string): Promise<RepairSurfaceItem[]> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, instructions, pending_actions, log_tail, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "repair")
    .in("status", ["needs_approval", "needs_attention"])
    .order("created_at", { ascending: false })
    .limit(50);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    let title = String(row.spec_slug || "");
    try {
      const instr = row.instructions ? JSON.parse(String(row.instructions)) : {};
      if (instr.title) title = String(instr.title);
    } catch {
      /* instructions not JSON — fall back to the slug */
    }
    const actions = Array.isArray(row.pending_actions) ? (row.pending_actions as Array<Record<string, unknown>>) : [];
    const buildAction = actions.find((a) => a.type === "repair_build" && a.status === "pending");
    const specSlug = buildAction ? String(buildAction.spec_slug || "") || null : null;
    return {
      jobId: String(row.id),
      signature: String(row.spec_slug || ""),
      title,
      diagnosis: typeof row.log_tail === "string" ? row.log_tail : "",
      specSlug,
      state: row.status === "needs_approval" && specSlug ? "proposed" : "needs-human",
      createdAt: String(row.created_at || ""),
    };
  });
}

// ── Director-dismissed surface (director-supervised-repair-dismissal Phase 2) ──
// When the Platform/DevOps Director (Ada) clears one of Rafa's no-fix items, the repair job flips to
// `completed` and leaves getOpenRepairs — so without this it would silently vanish. Phase 2 keeps it
// VISIBLE on the Control Tower as "🛠️ Dismissed by Ada — <reasoning>" with a one-tap Re-open (the CEO's
// supervision over the supervisor). The list is the recent `dismissed_repair` director_activity rows
// MINUS any the owner already re-opened (a later `reopened_repair` row on the same job).

/** A repair item the Director dismissed — surfaced read-only with Ada's reasoning + a Re-open affordance. */
export interface DirectorDismissedRepairItem {
  /** the completed repair job Ada dismissed (the Re-open target). */
  jobId: string;
  /** the error_events signature / loop:<id> the dismissal cleared. */
  signature: string;
  /** short label of the originating error/alert. */
  title: string;
  /** Ada's OWN independent reasoning for clearing it (the activity row's `reason`). */
  reasoning: string;
  dismissedAt: string;
}

/** How far back the Control Tower shows Ada's dismissals (a 14-day audit window — old, settled noise drops off). */
const DIRECTOR_DISMISS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * READ-ONLY: the Director's recent repair dismissals still standing (not re-opened) for this workspace.
 * Reads `dismissed_repair` director_activity rows in the last 14 days and drops any whose job carries a
 * later `reopened_repair` row (the owner tapped Re-open). Title comes from the dismissal's metadata
 * (written by `applyDirectorDismissal`), falling back to the signature.
 */
export async function getDirectorDismissedRepairs(admin: Admin, workspaceId: string): Promise<DirectorDismissedRepairItem[]> {
  const sinceIso = new Date(Date.now() - DIRECTOR_DISMISS_WINDOW_MS).toISOString();
  const { data } = await admin
    .from("director_activity")
    .select("action_kind, reason, metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("director_function", "platform")
    .in("action_kind", ["dismissed_repair", "reopened_repair"])
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as Array<{ action_kind: string; reason: string | null; metadata: Record<string, unknown> | null; created_at: string }>;
  const reopened = new Set<string>();
  for (const r of rows) {
    if (r.action_kind !== "reopened_repair") continue;
    const jobId = r.metadata?.["repair_job_id"];
    if (typeof jobId === "string") reopened.add(jobId);
  }

  const out: DirectorDismissedRepairItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.action_kind !== "dismissed_repair") continue;
    const meta = r.metadata ?? {};
    const jobId = typeof meta["repair_job_id"] === "string" ? (meta["repair_job_id"] as string) : "";
    if (!jobId || reopened.has(jobId) || seen.has(jobId)) continue; // re-opened or already listed → skip
    seen.add(jobId);
    const signature = typeof meta["signature"] === "string" ? (meta["signature"] as string) : "";
    const title = typeof meta["title"] === "string" && meta["title"] ? (meta["title"] as string) : signature;
    out.push({ jobId, signature, title, reasoning: r.reason ?? "", dismissedAt: r.created_at });
  }
  return out;
}

// ── retire-md-spec-writers-db-is-sole-spec Phase 2 (repair lane) ─────────────
//
// Rafa's box session returns a repair proposal (verdict + spec). The DEFAULT author flow used to
// hand this to the markdown chokepoint (`authorSpecRowFromMarkdown` → prose-only Verification
// stamped `exec_kind='needs_human'`), which the every-writer-authors-machine-runnable-verifications
// gate then rejected with `MissingMachineCheckError` — every repair fix-spec parked at the CEO
// inbox. This helper builds the STRUCTURED input the runRepairJob now hands to
// `authorSpecRowStructured` directly: title / summary / owner / parent + a single-phase body +
// TYPED machine checks (at minimum `exec_kind:'tsc'`; when the proposal names an implicated
// `target` file the helper adds a `exec_kind:'grep'` check on that file so the deterministic
// spec-check runner verifies the fix actually landed after merge). The verification bullet on
// this phase is "repair-agent.ts handles typed machine checks (references exec_kind)" — the
// `exec_kind` string appears here, in this module, at the site that emits it.
//
// The helper PREFERS the checks Rafa provided (a phased proposal with per-phase typed checks)
// and DERIVES defaults only when Rafa emitted the flat legacy shape (backward compat with older
// box sessions during the rollout, and a safety net if the LLM slips a required field). Nothing
// here executes the checks or writes the DB — that stays in `authorSpecRowStructured`.

/** The platform mandate every repair fix-spec anchors under — mirrors mario / coverage-register. */
export const REPAIR_FIX_PARENT_PROSE =
  `[[../functions/platform]] — "Infra & DevOps / reliability" mandate: repair-agent's durable ` +
  `fix so the originating Control Tower signature stops re-firing.`;
export const REPAIR_FIX_PARENT_KIND = "mandate" as const;
export const REPAIR_FIX_PARENT_REF = "platform#infra-devops-reliability" as const;

/** One structured phase inside Rafa's proposal — mirrors [[author-spec]] `StructuredPhaseInput` but
 *  every field is optional so the helper can fill the required-shape defaults from the flat proposal. */
export interface RafaProposalPhase {
  title?: string;
  body?: string;
  verification?: string;
  why?: string;
  what?: string;
  checks?: RafaProposalCheck[];
}

/** One typed check inside a Rafa proposal phase — permissive on input; the helper coerces to
 *  [[spec-phase-checks-table]] `SpecPhaseCheckInput` after validating shape. */
export interface RafaProposalCheck {
  position?: number;
  description?: string;
  kind?: string;
  exec_kind?: string;
  params?: unknown;
}

/** Rafa's structured repair-spec proposal — the legacy flat fields (intent/problem/proposedChange/…)
 *  are preserved for backward compat while a session rollout lands, alongside the new `phases[]` +
 *  intent columns the structured chokepoint reads. */
export interface RepairProposal {
  slug?: string;
  title?: string;
  owner?: string;
  parent?: string;
  /** the legacy pointer to a specific origin spec — persists to `specs.related_spec`, NEVER the parent. */
  relatedSpec?: string;
  related_spec?: string;
  /** plain-language WHY this spec exists — populates `specs.why`. Falls back through legacy fields. */
  why?: string;
  /** plain-language WHAT changes when this ships — populates `specs.what`. Falls back through legacy fields. */
  what?: string;
  /** legacy — a one-paragraph summary of the fix; used as fallback for `what`. */
  intent?: string;
  /** legacy — plain-prose statement of what's failing; folded into the phase body. */
  problem?: string;
  /** legacy — plain-prose statement of the change; folded into the phase body. */
  proposedChange?: string;
  /** legacy — the SPECIFIC one-phase build step; used as the phase title. */
  phase?: string;
  /** the implicated file (machine hint) — feeds the derived `exec_kind:'grep'` default check. */
  target?: string;
  /** the NEW structured shape Rafa emits under the retire-md-spec-writers-db-is-sole-spec Phase 2
   *  prompt update. When present, its checks[] win over the derived defaults. */
  phases?: RafaProposalPhase[];
}

/** Author-spec's four kinds the deterministic runner may execute — mirrors `AUTO_TESTABLE_EXEC_KINDS`
 *  in [[spec-phase-checks-table]]. `needs_human` is safe-default; anything else typo'd falls through. */
const AUTO_TESTABLE_EXEC_KINDS: ReadonlySet<SpecPhaseCheckExecKind> = new Set([
  "tsc",
  "grep",
  "ci_status",
  "http_get",
  "db_probe_readonly",
  "unit_test",
  "build",
]);

function coerceExecKind(value: unknown): SpecPhaseCheckExecKind | null {
  if (typeof value !== "string") return null;
  if (value === "needs_human") return "needs_human";
  return AUTO_TESTABLE_EXEC_KINDS.has(value as SpecPhaseCheckExecKind)
    ? (value as SpecPhaseCheckExecKind)
    : null;
}

/**
 * DERIVED defaults for a repair phase — at minimum a `exec_kind:'tsc'` check (repair fix-specs always
 * gate on tsc-clean), plus a `exec_kind:'grep'` check on the implicated file when known so a merged
 * fix that never actually touched that file fails the check without needing to read anyone's prose.
 * Pure — the caller passes the normalized target and the exact regex pattern to look for (the fix
 * fingerprint), else the grep check is omitted rather than fabricated.
 */
export function derivedDefaultRepairChecks(input: {
  target: string | null | undefined;
  /** the fingerprint substring to look for in the target file (a function name, guard clause,
   *  error message). If omitted, the derived default is a bare tsc check — never a fabricated grep. */
  fingerprint?: string | null;
}): SpecPhaseCheckInput[] {
  const out: SpecPhaseCheckInput[] = [
    {
      position: 1,
      description: "Repo typechecks clean (`npx tsc --noEmit`) after the repair lands.",
      kind: "auto",
      exec_kind: "tsc",
      params: null,
    },
  ];
  const path = normalizeImplicatedFile(input.target);
  const pattern = (input.fingerprint || "").trim();
  if (path && pattern) {
    out.push({
      position: 2,
      description: `\`${pattern}\` is present in \`${path}\` (the repair actually landed the guard/fix).`,
      kind: "auto",
      exec_kind: "grep",
      params: { path, pattern, expect: "present" },
    });
  }
  return out;
}

/**
 * Coerce a Rafa-provided phase's checks[] into typed `SpecPhaseCheckInput[]`. Silently drops rows
 * missing an `exec_kind` that the runner understands — the author chokepoint's
 * `assertEveryPhaseHasMachineCheck` catches "no valid machine check remaining" and triggers the
 * one-retry re-prompt in runRepairJob (do NOT park the CEO on Rafa's first LLM slip).
 */
function coerceRafaChecks(rafaChecks: RafaProposalCheck[] | undefined | null): SpecPhaseCheckInput[] {
  if (!Array.isArray(rafaChecks)) return [];
  const out: SpecPhaseCheckInput[] = [];
  rafaChecks.forEach((c, idx) => {
    const execKind = coerceExecKind(c?.exec_kind);
    if (!execKind) return; // drop typo'd exec_kinds; the chokepoint's fail-loud gate will retry.
    const position = typeof c?.position === "number" && Number.isFinite(c.position) ? c.position : idx + 1;
    const description = (typeof c?.description === "string" && c.description.trim()) || `check ${position}`;
    const kind = c?.kind === "human" ? "human" : "auto";
    out.push({
      position,
      description,
      kind,
      exec_kind: execKind,
      params: c?.params ?? null,
    } as SpecPhaseCheckInput);
  });
  return out;
}

/** The legacy body Rafa's older sessions produce collapsed into a single Phase-1 body — mirrors the
 *  `repairSpecMarkdown` phase body shape (Problem / Proposed change / Why / Build step) so the DB
 *  round-trip renders the same human-readable review content the founder sees on the Roadmap board. */
function legacyPhaseBody(proposal: RepairProposal, signature: string, rootCause: string): string {
  const problem = (proposal.problem || "").trim() || "(see the repair diagnosis on the Control Tower repair feed)";
  const proposed = (proposal.proposedChange || "").trim();
  const why = (proposal.why || "").trim();
  const target = (proposal.target || "").trim();
  const buildStep = proposed
    ? `Make the change described under **Proposed change** above${target ? ` (in \`${target}\`)` : ""}, add/update its brain page, and gate on \`npx tsc --noEmit\`.`
    : `Scope the fix from the Problem above${target ? ` (likely in \`${target}\`)` : ""}; land it + its brain page; gate on \`npx tsc --noEmit\`.`;
  return [
    `### Problem`,
    problem,
    ``,
    `### Proposed change`,
    proposed || "(the fix scoped from the Problem above — see the repair diagnosis on the Control Tower repair feed)",
    ...(target ? [``, `**Target file:** \`${target}\``] : []),
    ``,
    `### Why`,
    why || "Addresses the root cause traced above rather than papering over the symptom.",
    ``,
    `### Build step`,
    buildStep,
    ``,
    // Machine markers preserved verbatim in the phase body — [[parseRepairSpecMeta]] reads these on
    // the DB round-trip (getSpec.raw re-serializes the phase body byte-for-byte).
    `**Repair-root-cause:** \`${rootCause}\``,
    `**Repair-signature:** \`${signature}\``,
  ].join("\n");
}

function legacyPhaseVerification(signature: string): string {
  return `- Re-trigger the originating condition (signature \`${signature}\`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.`;
}

/** Strip a leading "Phase N —/-/:" prefix a Rafa phase title may carry — mirrors builder-worker's
 *  `stripPhasePrefix` so the serializer's own `## Phase N — ` numbering never double-prefixes. */
function stripLeadingPhasePrefix(name: string): string {
  return String(name || "").replace(/^\s*phase\s*\d+\s*[—\-:]\s*/i, "").trim();
}

/**
 * Build the [[author-spec]] `StructuredSpecInput` from Rafa's proposal — the ONE typed door
 * `runRepairJob` hands to `authorSpecRowStructured`. Deterministic + pure (no DB / no LLM). Every
 * emitted phase carries `exec_kind`-typed machine checks per the retire-md-spec-writers-db-is-sole-
 * spec Phase 2 mandate; the phase body preserves the `**Repair-root-cause:** / **Repair-signature:**`
 * markers so [[parseRepairSpecMeta]] still round-trips.
 *
 * PREFERRED shape: Rafa's proposal carries `phases[]` with per-phase typed `checks[]` — those win.
 * FALLBACK shape (backward compat with older box sessions during the rollout): the flat proposal
 * (intent/problem/proposedChange/target) is collapsed into a single Phase 1 whose body is the
 * legacy prose and whose checks are the `derivedDefaultRepairChecks(target, fingerprint)` output.
 * When Rafa omits every valid check the returned input STILL round-trips a bare `exec_kind:'tsc'`
 * default, so a benign LLM slip never parks the CEO — the chokepoint only rejects if Rafa emits
 * explicit-but-invalid params (typo'd exec_kind, malformed grep path — validated at the SDK layer).
 */
export function buildRepairSpecInput(
  proposal: RepairProposal,
  ctx: { signature: string; verdict: string; rootCause: string },
): StructuredSpecInput {
  const title = String(proposal.title || `Repair signature ${ctx.signature}`).trim() || `Repair signature ${ctx.signature}`;
  const relatedSpec =
    typeof proposal.relatedSpec === "string"
      ? proposal.relatedSpec
      : typeof proposal.related_spec === "string"
        ? proposal.related_spec
        : "";

  const specWhy =
    (proposal.why && proposal.why.trim()) ||
    `The Control Tower signature \`${ctx.signature}\` (verdict: ${ctx.verdict}) is recurring; ` +
      `without a durable fix, the same error keeps re-firing and the parked repair job never clears.`;
  const specWhat =
    (proposal.what && proposal.what.trim()) ||
    (proposal.intent && proposal.intent.trim()) ||
    `When this fix ships, the originating condition behind signature \`${ctx.signature}\` stops ` +
      `re-firing and the Control Tower tile stays green on the next re-trigger.`;

  const summary = (proposal.intent && proposal.intent.trim()) || null;

  // Rafa's NEW phases[] shape wins when present + non-empty. Legacy proposals collapse to a single
  // Phase 1 whose body is the prose Problem/Proposed change/Why/Build step block.
  const hasNewPhases = Array.isArray(proposal.phases) && proposal.phases.length > 0;
  const phases: StructuredSpecInput["phases"] = hasNewPhases
    ? proposal.phases!.map((p, idx) => {
        const rafaChecks = coerceRafaChecks(p.checks);
        const derived = derivedDefaultRepairChecks({ target: proposal.target, fingerprint: null });
        // A Rafa-provided check wins when it validates; otherwise derived defaults keep the phase
        // machine-runnable. The chokepoint STILL rejects a phase whose remaining checks fail
        // `validateExecutableCheck` (a malformed grep path etc) — the retry-once path handles that.
        const checks = rafaChecks.length ? rafaChecks : derived;
        const title = stripLeadingPhasePrefix(p.title || `Phase ${idx + 1}`) || `Phase ${idx + 1}`;
        // Legacy body + markers ride on Phase 1 so [[parseRepairSpecMeta]] keeps working; later phases
        // fall through to Rafa's body verbatim.
        const body =
          idx === 0
            ? (p.body && p.body.trim()) || legacyPhaseBody(proposal, ctx.signature, ctx.rootCause)
            : (p.body && p.body.trim()) || `Phase ${idx + 1} body.`;
        const verification =
          (p.verification && p.verification.trim()) || legacyPhaseVerification(ctx.signature);
        const why = (p.why && p.why.trim()) || specWhy;
        const what = (p.what && p.what.trim()) || specWhat;
        return { title, body, verification, why, what, status: "planned" as const, checks };
      })
    : [
        {
          title: stripLeadingPhasePrefix(proposal.phase || "") || (proposal.target ? `Fix ${proposal.target}` : "Land the fix"),
          body: legacyPhaseBody(proposal, ctx.signature, ctx.rootCause),
          verification: legacyPhaseVerification(ctx.signature),
          why: specWhy,
          what: specWhat,
          status: "planned" as const,
          checks: derivedDefaultRepairChecks({ target: proposal.target, fingerprint: null }),
        },
      ];

  const input: StructuredSpecInput = {
    title,
    summary,
    owner: (proposal.owner && proposal.owner.trim()) || "[[../functions/platform]]",
    parent: (proposal.parent && proposal.parent.trim()) || REPAIR_FIX_PARENT_PROSE,
    why: specWhy,
    what: specWhat,
    phases,
  };
  if (relatedSpec.trim()) {
    // no-op — related_spec rides on AuthorSpecOpts.relatedSpec (not on StructuredSpecInput). The caller
    // (`groupOrAuthorRepairSpec`) forwards it into the `AuthorSpecOpts` object it hands to
    // `authorSpecRowStructured`. Kept here as a comment so a future reader doesn't try to shove it into
    // the spec input.
  }
  return input;
}

