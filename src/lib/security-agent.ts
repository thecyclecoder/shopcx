/**
 * security-agent — the queue plumbing + autonomy policy behind the **Security / Dependency Agent box
 * worker** ([[docs/brain/specs/security-dependency-agent.md]]). "the regression agent, but for the
 * security gap the auto-merge opened." Persona: **Vault — Security Guardian** (🔒).
 *
 * North star (supervisable autonomy): auto-merge optimizes the bounded proxy "ship the fix"; its
 * degenerate state is shipping a fix that introduces an injection / secret-leak / authz hole. This
 * agent is the security supervisor ABOVE that proxy — it REVIEWS read-only and ESCALATES, never
 * auto-mutates. It classifies findings and, on a real/ambiguous one, AUTHORS a scoped fix spec +
 * SURFACES it for one-tap owner Build (routed via [[approval-router]]). It NEVER edits product code,
 * opens its own PR, or bumps a dependency — the owner-gated build applies any fix (mirrors
 * [[repair-agent]] / [[regression-agent]]).
 *
 * Two entry points (event-driven — there is NO per-diff cron; the merge IS the trigger):
 *   - `enqueueSecurityReviewJob` — fired from the merge hook ([[agent-jobs]] `applyMergedBuildEffects`,
 *     run by BOTH the manual-squash reconcile and the auto-merge webhook path) on every merged
 *     `claude/*` build diff. Deduped by the merge SHA — one review per distinct diff, never double-filed.
 *   - `enqueueDepWatchJob` — fired daily by the [[inngest/security-dep-watch]] cron. Deduped to ≤1 live
 *     dep-watch scan; the box job runs `npm audit` on the real tree and authors an upgrade-fix spec.
 *   - the box worker's `runSecurityReviewJob` (scripts/builder-worker.ts) consumes both off the queue.
 */
import { createHash } from "crypto";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The verdict the box reaches per security finding (it cites the location, never the secret value). */
export type SecurityVerdict =
  | "real-vuln" // a genuine vulnerability the diff introduced → author a scoped fix spec, SURFACE for owner Build.
  | "needs-human" // can't confidently classify (ambiguous / needs context only a human has) → surface, no spec.
  | "false-positive"; // not actually a vulnerability (safe pattern / already-mitigated) → clean verdict, no spec.

/** The function whose objective owns this worker — the Platform/DevOps Director supervises it. */
export const SECURITY_DIRECTOR_FUNCTION = "platform";

/** Stable spec_slug of the daily dependency-upgrade fix spec (find-or-update, never N of them). */
export const SECURITY_DEP_UPGRADE_SLUG = "security-dep-upgrades";
/** The sentinel spec_slug carried by a dep-watch scan job (so it dedups distinctly from per-diff jobs). */
export const SECURITY_DEP_WATCH_SLUG = "security-dep-watch";

/** A fix authored within this window is "pending deploy" — don't re-surface the same dep finding. */
export const SECURITY_RECENT_FIX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/** Statuses that mean a security-review job is still "live" — being worked or surfaced (awaiting owner). */
export const LIVE_SECURITY_STATUSES = [
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
  "needs_attention",
];

/** Shape of a per-diff security-review job's `instructions` JSON — the brief the box loads to review. */
export interface SecurityDiffInstructions {
  mode: "diff";
  /** the merged commit SHA — the per-diff dedup key + what the box `git show`s to read the diff. */
  merge_sha: string;
  /** the merged spec slug (or `pr-{number}`) — for the surfaced item + the authored fix's `Fixes:` link. */
  spec_slug: string;
  /** the merged PR number, when known. */
  pr_number?: number | null;
  /** set on a TERMINAL job by the box: the verdict it reached. */
  verdict?: string;
  /** set when the box authored a fix: the slug it wrote. */
  authored_slug?: string;
}

/** Shape of a dep-watch scan job's `instructions` JSON. */
export interface SecurityDepWatchInstructions {
  mode: "dep-watch";
  verdict?: string;
  authored_slug?: string;
  /** a stable hash of the advisory set the scan found (so an unchanged set never re-files). */
  finding_signature?: string;
}

/** A short, stable signature for a merged diff = the merge SHA (already globally unique). */
export function securitySha12(mergeSha: string): string {
  return String(mergeSha || "").trim().slice(0, 12);
}

/** A stable signature for a dependency-advisory SET (sorted package@severity list, hashed). Pure. */
export function depFindingSignature(findings: Array<{ name: string; severity: string }>): string {
  const keys = [...new Set((findings || []).map((f) => `${String(f.name || "").trim()}@${String(f.severity || "").trim()}`).filter(Boolean))].sort();
  if (!keys.length) return "clean";
  return createHash("sha1").update(keys.join("|")).digest("hex").slice(0, 12);
}

/**
 * Resolve the workspace a security job lands under. A merged-diff review is GLOBAL infra (not
 * workspace-scoped) and the build queue is effectively single-tenant — so ride the SAME workspace the
 * build queue uses (the latest agent_jobs row's workspace), falling back to the first workspace.
 * Returns null only if there is no workspace at all (then the caller no-ops). Mirrors the repair-agent.
 */
async function resolveSecurityWorkspace(admin: Admin): Promise<string | null> {
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

export interface EnqueueSecurityReviewInput {
  /** the merged commit SHA — the per-diff dedup key. */
  mergeSha: string;
  /** the merged spec slug (or `pr-{number}`). */
  specSlug: string;
  /** the merged PR number, when known. */
  prNumber?: number | null;
  /** override the workspace; else resolved from the latest job / first workspace. */
  workspaceId?: string;
}

/**
 * Enqueue a per-diff `security-review` job for a merged `claude/*` build. Best-effort + idempotent:
 * deduped by the merge SHA so a re-run (board reconcile + auto-merge webhook both firing for one merge)
 * NEVER double-files. `spec_slug` carries the merged slug for surfacing; the SHA lives in `instructions`
 * (the dedup key). Never throws — it rides the merge hook, and a throw there is worse than the gap.
 */
export async function enqueueSecurityReviewJob(admin: Admin, input: EnqueueSecurityReviewInput): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    const sha = securitySha12(input.mergeSha);
    if (!sha) return { enqueued: false, reason: "no merge sha" };

    // Dedup by merge SHA — scan recent security-review jobs (diff mode) for a matching SHA in ANY status
    // (a clean review COMPLETED for this SHA must not re-file either). SHAs are globally unique.
    const sinceIso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await admin
      .from("agent_jobs")
      .select("id, instructions")
      .eq("kind", "security-review")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(300);
    for (const r of (recent ?? []) as Array<{ instructions?: string }>) {
      try {
        const instr = JSON.parse(String(r.instructions || "{}")) as SecurityDiffInstructions;
        if (instr.mode === "diff" && securitySha12(instr.merge_sha) === sha) {
          return { enqueued: false, reason: "security-review already filed for this merge SHA" };
        }
      } catch {
        /* not JSON — ignore */
      }
    }

    const workspaceId = input.workspaceId || (await resolveSecurityWorkspace(admin));
    if (!workspaceId) return { enqueued: false, reason: "no workspace to attach the security-review job to" };

    const instructions: SecurityDiffInstructions = {
      mode: "diff",
      merge_sha: input.mergeSha,
      spec_slug: input.specSlug,
      pr_number: input.prNumber ?? null,
    };
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: input.specSlug,
      kind: "security-review",
      status: "queued",
      instructions: JSON.stringify(instructions),
    });
    if (error) {
      console.warn(`[security-agent] per-diff enqueue failed for ${sha}:`, error.message);
      return { enqueued: false, reason: error.message };
    }
    return { enqueued: true, reason: sha };
  } catch (err) {
    console.warn("[security-agent] enqueueSecurityReviewJob threw:", err instanceof Error ? err.message : err);
    return { enqueued: false, reason: "threw" };
  }
}

/**
 * Enqueue the daily dependency-CVE-watch scan job. Best-effort + idempotent: no-op if a dep-watch scan
 * is already live OR a non-dismissed one COMPLETED within the recent window (its upgrade-fix is pending
 * deploy — don't re-scan meanwhile). The box job runs `npm audit` on the real tree and (on a finding)
 * authors the upgrade-fix spec + surfaces the Build card. NEVER throws — it rides the cron's act loop.
 */
export async function enqueueDepWatchJob(admin: Admin, opts: { workspaceId?: string } = {}): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    const { data: recent } = await admin
      .from("agent_jobs")
      .select("id, status, error, created_at")
      .eq("kind", "security-review")
      .eq("spec_slug", SECURITY_DEP_WATCH_SLUG)
      .order("created_at", { ascending: false })
      .limit(5);
    const rows = (recent ?? []) as Array<{ id: string; status: string; error: string | null; created_at: string }>;
    if (rows.some((r) => LIVE_SECURITY_STATUSES.includes(r.status))) {
      return { enqueued: false, reason: "live dep-watch scan exists" };
    }
    const windowStart = Date.now() - SECURITY_RECENT_FIX_WINDOW_MS;
    const recentlyScanned = rows.some((r) => r.status === "completed" && Date.parse(r.created_at) >= windowStart);
    if (recentlyScanned) return { enqueued: false, reason: "dep-watch scanned within the recent window" };

    const workspaceId = opts.workspaceId || (await resolveSecurityWorkspace(admin));
    if (!workspaceId) return { enqueued: false, reason: "no workspace to attach the dep-watch job to" };

    const instructions: SecurityDepWatchInstructions = { mode: "dep-watch" };
    const { error } = await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: SECURITY_DEP_WATCH_SLUG,
      kind: "security-review",
      status: "queued",
      instructions: JSON.stringify(instructions),
    });
    if (error) {
      console.warn("[security-agent] dep-watch enqueue failed:", error.message);
      return { enqueued: false, reason: error.message };
    }
    return { enqueued: true };
  } catch (err) {
    console.warn("[security-agent] enqueueDepWatchJob threw:", err instanceof Error ? err.message : err);
    return { enqueued: false, reason: "threw" };
  }
}

// ── Dashboard surface (read-only) ────────────────────────────────────────────
// A security-review job surfaces while it waits on the owner: `needs_approval` (a fix/upgrade spec
// authored + a Build card, awaiting the owner's queue-the-build) or `needs_attention` (a needs-human
// finding — no spec, no auto path). Clean reviews complete silently and never appear here. The routed
// Approval Request is emitted generically by [[approval-inbox]] (KIND_TO_FUNCTION maps security-review →
// platform via the agent-kind tile), so no per-agent Control Tower route is needed.

export interface SecuritySurfaceItem {
  jobId: string;
  /** the merged spec slug / `security-dep-watch` this job reviews. */
  specSlug: string;
  /** 'diff' = a per-merge review · 'dep-watch' = the CVE/dependency scan. */
  mode: "diff" | "dep-watch";
  /** the box's plain-text finding + classification. */
  finding: string;
  /** the authored fix/upgrade spec slug (set for a routed fix; null for needs-human). */
  fixSlug: string | null;
  /** 'routed' = a fix spec authored + awaiting Build; 'needs-human' = no spec, Dismiss only. */
  state: "routed" | "needs-human";
  createdAt: string;
}

/**
 * READ-ONLY: the open security items awaiting the owner. Surfaced security-review jobs are those in
 * `needs_approval` (a routed fix) or `needs_attention` (a needs-human finding). Clean reviews complete
 * silently and never appear here.
 */
export async function getOpenSecurityReviews(admin: Admin, workspaceId: string): Promise<SecuritySurfaceItem[]> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, instructions, pending_actions, log_tail, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "security-review")
    .in("status", ["needs_approval", "needs_attention"])
    .order("created_at", { ascending: false })
    .limit(50);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    let mode: "diff" | "dep-watch" = "diff";
    try {
      const instr = JSON.parse(String(row.instructions || "{}")) as { mode?: string };
      if (instr.mode === "dep-watch") mode = "dep-watch";
    } catch {
      /* instructions not JSON — default to diff */
    }
    const actions = Array.isArray(row.pending_actions) ? (row.pending_actions as Array<Record<string, unknown>>) : [];
    const buildAction = actions.find((a) => a.type === "security_build" && a.status === "pending");
    const fixSlug = buildAction ? String(buildAction.spec_slug || "") || null : null;
    return {
      jobId: String(row.id),
      specSlug: String(row.spec_slug || ""),
      mode,
      finding: typeof row.log_tail === "string" ? row.log_tail : "",
      fixSlug,
      state: row.status === "needs_approval" && fixSlug ? "routed" : "needs-human",
      createdAt: String(row.created_at || ""),
    };
  });
}
