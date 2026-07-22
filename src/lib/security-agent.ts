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
 * Three entry points (event-driven — there is NO per-diff cron; the merge / preview-ready IS the trigger):
 *   - `enqueueSecurityReviewJob` (post-merge `diff` mode) — fired from the merge hook
 *     ([[agent-jobs]] `applyMergedBuildEffects`, run by BOTH the manual-squash reconcile and the
 *     auto-merge webhook path) on every merged `claude/*` build diff. Deduped by the merge SHA — one
 *     review per distinct diff, never double-filed.
 *   - `enqueueSecurityReviewJob` (pre-merge `branch` mode, [[../specs/security-test-on-preview-pre-merge]]
 *     Phase 1) — fired when a `claude/*` build reaches a READY preview + is still unmerged (the
 *     [[per-build-vercel-preview-deploys]] hook). The review scans the UNMERGED diff
 *     (`git diff main...claude/<branch>`) and any runtime probe hits the per-build preview origin —
 *     so a vulnerability surfaces BEFORE the merge, not after. Deduped to one open review per branch.
 *   - `enqueueDepWatchJob` — fired daily by the [[inngest/security-dep-watch]] cron. Deduped to ≤1 live
 *     dep-watch scan; the box job runs `npm audit` on the real tree and authors an upgrade-fix spec.
 *   - the box worker's `runSecurityReviewJob` (scripts/builder-worker.ts) consumes all three off the queue.
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

/**
 * Statuses where a security-review job is RUNNING (not yet surfaced for the owner) — drives the
 * timeline's Security stage = `active` and Phase 3's fold gate's "defer until cleared" branch.
 */
export const RUNNING_SECURITY_STATUSES = ["queued", "claimed", "building", "needs_input", "queued_resume"] as const;

/**
 * Statuses where a security-review job is SURFACED for the owner — a routed real-vuln fix
 * (`needs_approval`) or a needs-human finding (`needs_attention`). Drives the timeline's Security
 * stage = `needs-attention` and Phase 3's fold gate's "block" branch.
 */
export const SURFACED_SECURITY_STATUSES = ["needs_approval", "needs_attention"] as const;

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

/**
 * Shape of a PRE-MERGE per-branch security-review job's `instructions` JSON
 * ([[../specs/security-test-on-preview-pre-merge]] Phase 1). The reviewer scans the UNMERGED diff
 * (`git diff main...{branch}`) — NOT a post-merge main commit — and any runtime probe hits the
 * per-build `preview_origin`, so a vulnerability surfaces before the merge.
 */
export interface SecurityBranchInstructions {
  mode: "branch";
  /** the `claude/*` build branch — the per-branch dedup key + what the box `git diff main...`s to read. */
  branch: string;
  /** the per-build Vercel preview origin (e.g. `https://shopcx-abc123-xxx.vercel.app`) — where any
   * runtime probe lands, instead of prod. */
  preview_origin: string;
  /** the build's spec slug — for the surfaced item + the authored fix's `Fixes:` link. */
  spec_slug: string;
  /** the build's PR number, when known. */
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

/**
 * Per-diff (post-merge) input — keyed/deduped by the merge SHA. The existing call site
 * ([[agent-jobs]] `applyMergedBuildEffects`).
 */
export interface EnqueueSecurityReviewDiffInput {
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
 * Per-branch (pre-merge) input — keyed/deduped by the build branch ([[../specs/security-test-on-preview-pre-merge]]
 * Phase 1). Fired when a `claude/*` build reaches a READY preview + is unmerged — the
 * [[per-build-vercel-preview-deploys]] hook calls this with the build branch + per-build preview origin.
 */
export interface EnqueueSecurityReviewBranchInput {
  /** the `claude/*` build branch — the per-branch dedup key. */
  branch: string;
  /** the per-build Vercel preview origin (e.g. `https://shopcx-abc123-xxx.vercel.app`). */
  previewOrigin: string;
  /** the build's spec slug. */
  specSlug: string;
  /** the build's PR number, when known. */
  prNumber?: number | null;
  /** override the workspace; else resolved from the latest job / first workspace. */
  workspaceId?: string;
}

export type EnqueueSecurityReviewInput = EnqueueSecurityReviewDiffInput | EnqueueSecurityReviewBranchInput;

function isBranchInput(input: EnqueueSecurityReviewInput): input is EnqueueSecurityReviewBranchInput {
  return typeof (input as EnqueueSecurityReviewBranchInput).branch === "string"
    && (input as EnqueueSecurityReviewBranchInput).branch.length > 0;
}

/**
 * Enqueue a `security-review` job. Two modes (one lane):
 *
 *   - **`diff` (post-merge)** — caller passes `{mergeSha,specSlug,prNumber?}`. Deduped by the merge SHA so
 *     a re-run (board reconcile + auto-merge webhook both firing for one merge) NEVER double-files.
 *     `spec_slug` carries the merged slug for surfacing; the SHA lives in `instructions` (the dedup key).
 *
 *   - **`branch` (pre-merge)** — caller passes `{branch,previewOrigin,specSlug,prNumber?}`
 *     ([[../specs/security-test-on-preview-pre-merge]] Phase 1). Deduped to ONE OPEN review per branch
 *     (any live/surfaced security-review job with `spec_branch === branch`). The `securitySha12` /
 *     `depFindingSignature` signatures still converge same-finding recurrences once the box runs.
 *
 * Best-effort + idempotent + never throws — both call sites (the merge hook + the preview-ready hook) ride
 * other plumbing, and a throw there is worse than the gap.
 */
export async function enqueueSecurityReviewJob(admin: Admin, input: EnqueueSecurityReviewInput): Promise<{ enqueued: boolean; reason?: string }> {
  try {
    if (isBranchInput(input)) {
      return enqueueSecurityReviewBranch(admin, input);
    }
    return enqueueSecurityReviewDiff(admin, input);
  } catch (err) {
    console.warn("[security-agent] enqueueSecurityReviewJob threw:", err instanceof Error ? err.message : err);
    return { enqueued: false, reason: "threw" };
  }
}

async function enqueueSecurityReviewDiff(admin: Admin, input: EnqueueSecurityReviewDiffInput): Promise<{ enqueued: boolean; reason?: string }> {
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
}

/**
 * Pre-merge `branch`-mode enqueue ([[../specs/security-test-on-preview-pre-merge]] Phase 1). Dedup is
 * TWO-PART (vault-security-review-loop-fix):
 *
 *   1. ONE OPEN review per branch — skip if any security-review job with `spec_branch === branch` is in a
 *      live/surfaced status (queued / claimed / building / needs_input / needs_approval / queued_resume /
 *      needs_attention).
 *   2. ONE CLEAN review per UNCHANGED branch — skip if the branch already has a `completed` review that is
 *      NEWER than the latest build-job push on the branch. A clean review proves the branch's current diff
 *      is clean; re-reviewing the exact same diff every standing pass is the Vault loop. We only re-review
 *      once a genuinely newer build commit lands (the build job's `updated_at` advances past the review) —
 *      THAT new diff might re-introduce something the prior pass cleared, which is the only case the
 *      original "terminal never blocks a re-review" comment was protecting. A `failed` review never blocks
 *      (it never produced a verdict, so the branch is still un-reviewed).
 */
/**
 * fix-vault-post-merge-diff-backstop-7fbde0 — the STANDING-PASS BACKSTOP for the post-merge `diff` security
 * pass. The gap it closes: today the post-merge diff review fires ONLY reactively from the merge hook
 * ([[agent-jobs]] `applyMergedBuildEffects`, `enqueueSecurityReviewJob({mergeSha})`). That send is
 * fire-and-forget — if it's dropped (a Vercel deploy reaps the Inngest sync mid-flight, the box is down,
 * a transient error), the merged commit never gets its post-merge security pass and nothing re-checks.
 *
 * This is the cheap if-due re-sweep, mirroring `enqueueSpecTestIfDue` for
 * symmetry: enumerate the audit-authoritative source of every merged `claude/*` build in the window —
 * `spec_status_history` rows with `actor='merge:<sha>'` (written by `markSpecCardMergeShipped` inside
 * `applyMergedBuildEffects`, append-only + never deleted → survives `fold`). For each unique merge SHA
 * call `enqueueSecurityReviewJob` in diff mode; idempotency comes for free because
 * `enqueueSecurityReviewDiff` dedups by merge SHA across any-status security-review jobs in the last
 * 14d, so the re-sweep only enqueues the genuinely-missing ones and is safe to run every pass.
 *
 * ⭐ Why `spec_status_history`, NOT `getSpec()` → `spec_phases.merge_sha` / `specs.last_merge_sha`
 * (fix-vault-post-merge-diff-backstop-7fbde0-0845a3 — the regression fix): the earlier origin
 * fix resolved SHAs via `getSpec` + phase iteration. That gapped on FOLDED specs (their brain pages
 * live in `docs/brain/archive.d/`) — the observed orphans included `acquisition-research-hub` and
 * `ad-creative-scout`, both folded specs whose `spec_phases.merge_sha` was either NULL or unreachable
 * via `getSpec` for the caller's `(workspace_id, slug)` lookup (workspace mismatch / stale slug). The
 * audit ledger `spec_status_history` was written by the SAME hook that stamped the phases at merge
 * time (`markSpecCardMergeShipped` → `upsertCardState` appends `{field:'status', actor:'merge:<sha>'}`
 * + `{field:'phase', actor:'merge:<sha>'}` per shipped phase), and its rows are never deleted — so
 * every SHA the fold + phase-provenance path could resolve, the history can too, PLUS the ones fold
 * has since made unreachable. Same source the `audit-spec-shipped-state` job walks to re-stamp
 * provenance ([[spec-audit]] — the sanctioned ledger for "did this SHA merge for this slug").
 *
 * Wired into the platform-director standing pass ([[../../../scripts/builder-worker]]) next to
 * `backstopPreMergeChecks`, and hung off the daily [[../inngest/security-dep-watch]] cron as a second
 * net. Does NOT replace the reactive merge-hook enqueue — this is purely additive backstop coverage.
 * Best-effort + never throws.
 */
export interface EnqueueSecurityDiffIfDueResult {
  /** merge SHAs (12-char signature) whose diff-mode security review was (re-)enqueued this pass. */
  enqueued: string[];
  /** distinct merge SHAs (12-char signature) seen in the window from `spec_status_history`. */
  scanned: number;
  /** distinct merge SHAs resolved (same as `scanned` — kept for shape symmetry with the earlier probe). */
  resolved: number;
}

export async function enqueueSecurityDiffIfDue(
  admin: Admin,
  opts: { sinceMs?: number; workspaceId?: string } = {},
): Promise<EnqueueSecurityDiffIfDueResult> {
  const out: EnqueueSecurityDiffIfDueResult = { enqueued: [], scanned: 0, resolved: 0 };
  try {
    // Window mirrors the 14d dedup window inside enqueueSecurityReviewDiff — no point scanning beyond
    // the horizon the dedup would treat as "already filed", but recent enough to catch the reap gap.
    const sinceMs = opts.sinceMs ?? 14 * 24 * 60 * 60 * 1000;
    const sinceIso = new Date(Date.now() - sinceMs).toISOString();
    // Audit-authoritative source (see comment above): every merge writes `actor='merge:<sha>'` history
    // rows. Deduped inline by 12-char SHA signature — the SAME dedup enqueueSecurityReviewDiff applies.
    let query = admin
      .from("spec_status_history")
      .select("workspace_id, spec_slug, actor, at")
      .gte("at", sinceIso)
      .like("actor", "merge:%")
      .order("at", { ascending: false });
    if (opts.workspaceId) query = query.eq("workspace_id", opts.workspaceId);
    const { data: rows } = await query.limit(2000);

    // Dedup by 12-char SHA — one history slug (e.g. multi-phase spec) can write multiple `merge:<sha>`
    // rows for the SAME sha (one `field='status'` + N `field='phase'`), and multiple slugs can share a
    // SHA on a goal-branch M5 atomic merge. First occurrence wins for the `(specSlug, workspaceId)` tag.
    const bySha = new Map<string, { mergeSha: string; specSlug: string; workspaceId: string }>();
    for (const r of (rows ?? []) as Array<{ workspace_id: string; spec_slug: string; actor: string }>) {
      if (!r.actor?.startsWith("merge:")) continue;
      const mergeSha = r.actor.slice("merge:".length).trim();
      const short = securitySha12(mergeSha);
      if (!short) continue;
      if (bySha.has(short)) continue;
      if (!r.workspace_id || !r.spec_slug) continue;
      bySha.set(short, { mergeSha, specSlug: r.spec_slug, workspaceId: r.workspace_id });
    }
    out.scanned = bySha.size;
    out.resolved = bySha.size;
    // backsweep-skip-archived (hotfix): NEVER re-enqueue a post-merge diff review for a FOLDED/DEFERRED/archived
    // spec. This backstop exists to catch a RECENT ACTIVE merge whose reactive review was dropped — re-reviewing
    // the entire archived backlog (folded specs' old merges, observed ~360 in the 14d window) burns one Max
    // session PER spec for zero benefit (they were security-reviewed when they shipped). Load status for every
    // candidate slug once; keep only genuinely-active specs (skip folded/deferred, and skip UNKNOWN — no active
    // row means archived/removed → skip). This retires the earlier "catch folded specs' merges" intent, which was
    // the Max-burn runaway (2026-07-02).
    const candidateSlugs = [...new Set([...bySha.values()].map((h) => h.specSlug))];
    const activeKeys = new Set<string>();
    if (candidateSlugs.length) {
      const { data: specRows } = await admin
        .from("specs")
        .select("workspace_id, slug, status, deferred")
        .in("slug", candidateSlugs);
      for (const s of (specRows ?? []) as Array<{ workspace_id: string; slug: string; status: string | null; deferred: boolean | null }>) {
        if (s.status !== "folded" && s.status !== "deferred" && s.deferred !== true) activeKeys.add(`${s.workspace_id}:${s.slug}`);
      }
    }
    for (const [short, hit] of bySha) {
      if (!activeKeys.has(`${hit.workspaceId}:${hit.specSlug}`)) continue; // skip folded/deferred/archived → no Max burn
      try {
        const r = await enqueueSecurityReviewJob(admin, {
          mergeSha: hit.mergeSha,
          specSlug: hit.specSlug,
          prNumber: null,
          workspaceId: hit.workspaceId,
        });
        if (r.enqueued) out.enqueued.push(short);
      } catch (err) {
        console.warn(
          `[security-agent] enqueueSecurityDiffIfDue: enqueue threw for ${short} (continuing):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.warn(
      "[security-agent] enqueueSecurityDiffIfDue: pass threw (continuing):",
      err instanceof Error ? err.message : err,
    );
  }
  return out;
}

async function enqueueSecurityReviewBranch(admin: Admin, input: EnqueueSecurityReviewBranchInput): Promise<{ enqueued: boolean; reason?: string }> {
  const branch = String(input.branch || "").trim();
  if (!branch) return { enqueued: false, reason: "no branch" };
  if (!input.specSlug) return { enqueued: false, reason: "no spec slug" };

  // ⭐ (0) MERGED-BRANCH GUARD (post-merge backstop security-loop fix). A pre-merge branch review is meaningless
  // once the branch's PR has MERGED — the `claude/build-*` branch is DELETED, so the box would "review an
  // unmerged branch" that no longer exists, burning a Max session every standing pass (noop-pipeline-test-4 /
  // #837). The build job's post-merge state-advance flips it to `merged` and BUMPS its `updated_at`, which the
  // step-(2) "branch changed since clean review" test below mistook for a new push → re-enqueued forever. So
  // before any dedup: if the latest build job for this branch is `merged`, the branch is gone — never enqueue.
  const { data: lastBuildJob } = await admin
    .from("agent_jobs")
    .select("status, updated_at")
    .eq("kind", "build")
    .eq("spec_branch", branch)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if ((lastBuildJob as { status?: string } | null)?.status === "merged") {
    return { enqueued: false, reason: "branch's PR already merged (branch gone) — no pre-merge security review" };
  }

  // (1) Dedup by branch (one OPEN review per branch). `spec_branch` is the column the agent_jobs row carries
  // (set on insert below). The `securitySha12`/`depFindingSignature` signatures still converge same-finding
  // recurrences inside the box's review of the branch's diff.
  const { data: open } = await admin
    .from("agent_jobs")
    .select("id, status")
    .eq("kind", "security-review")
    .eq("spec_branch", branch)
    .in("status", LIVE_SECURITY_STATUSES as unknown as string[])
    .limit(1);
  if ((open ?? []).length > 0) {
    return { enqueued: false, reason: "security-review already open for this branch" };
  }

  // (2) Dedup by branch state (one CLEAN review per UNCHANGED branch — the loop fix). If the branch already
  // has a `completed` review, only re-review when the branch advanced SINCE that review with a NEW CODE PUSH —
  // NOT a status-only `updated_at` bump (a completed→merged flip is not a push; the (0) guard above already
  // dropped merged branches, but we also exclude `merged`/`completed` non-push bumps here so the comparison
  // keys on a genuine build push). Compare the latest completed review's `created_at` against the latest
  // NON-terminal build job's `updated_at`. Review newer-or-equal ⇒ same diff already cleared ⇒ skip (this is
  // what stopped the per-pass loop). A genuinely newer build push ⇒ re-review.
  const { data: lastClean } = await admin
    .from("agent_jobs")
    .select("created_at")
    .eq("kind", "security-review")
    .eq("spec_branch", branch)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastCleanAt = (lastClean as { created_at?: string } | null)?.created_at;
  if (lastCleanAt) {
    const lastBuildAt = (lastBuildJob as { status?: string; updated_at?: string } | null)?.status === "merged"
      ? null // a merged flip's bump is not a push (already returned above, but keep the comparison honest)
      : (lastBuildJob as { updated_at?: string } | null)?.updated_at;
    // No newer build push than the clean review ⇒ the reviewed diff is current ⇒ don't re-review.
    if (!lastBuildAt || Date.parse(lastBuildAt) <= Date.parse(lastCleanAt)) {
      return { enqueued: false, reason: "branch already has a clean security-review and has not changed since" };
    }
  }

  const workspaceId = input.workspaceId || (await resolveSecurityWorkspace(admin));
  if (!workspaceId) return { enqueued: false, reason: "no workspace to attach the security-review job to" };

  const instructions: SecurityBranchInstructions = {
    mode: "branch",
    branch,
    preview_origin: String(input.previewOrigin || ""),
    spec_slug: input.specSlug,
    pr_number: input.prNumber ?? null,
  };
  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: workspaceId,
    spec_slug: input.specSlug,
    spec_branch: branch,
    kind: "security-review",
    status: "queued",
    instructions: JSON.stringify(instructions),
  });
  if (error) {
    console.warn(`[security-agent] pre-merge enqueue failed for ${branch}:`, error.message);
    return { enqueued: false, reason: error.message };
  }
  return { enqueued: true, reason: branch };
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
// Approval Request is emitted generically by [[approval-inbox]] (the canonical node registry maps
// security-review → platform via the first-class Node `agent:security-review`), so no per-agent
// Control Tower route is needed.

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

/** Per-spec security-review rollup for the build-card lifecycle timeline. */
export interface SecurityStateBySlug {
  /** Any security-review job for this slug in `queued`/`claimed`/`building`/`needs_input`/`queued_resume` — the review is running. */
  live: boolean;
  /** Any security-review job in `needs_approval` (a routed real-vuln fix) or `needs_attention` (a needs-human finding) — surfaced to the owner. */
  surfaced: boolean;
  /** A `completed` security-review job exists for this slug AND no live/surfaced jobs are open — clean terminal state. */
  completedClean: boolean;
}

/**
 * Per-spec security-review rollup, one query for a whole board ([[build-card-lifecycle-timeline]]
 * Phase 2). Returns the SAME signals the timeline's Security node + Phase 3's fold gate will read
 * (they MUST agree). Read-only. Empty record when no security-review jobs exist. Per-diff (merge-SHA)
 * jobs are keyed by their merged `spec_slug`; the daily dep-watch lives under [[SECURITY_DEP_WATCH_SLUG]]
 * and is excluded from per-spec rollups (it's an infra job, not a per-spec lifecycle gate).
 *
 * Exclusion is by INFRA IDENTITY, not slug name: skip the `security-dep-watch` sentinel slug AND any
 * `dep-watch`-MODE row (the daily `npm audit` scan — infra, not a per-spec gate). The dep-watch agent's
 * AUTHORED upgrade-fix spec is a REAL shippable spec under the stable slug `security-dep-upgrades`; its
 * `diff`/`branch`-mode reviews ARE its per-spec security signal and MUST roll up (excluding that slug
 * blanked its Security node forever, so its fold gate could never clear — the "security-dep-upgrades is
 * lacking its security test" symptom). So `SECURITY_DEP_UPGRADE_SLUG` is NOT excluded here.
 */
export async function getSecurityStateBySlug(admin: Admin, workspaceId: string): Promise<Record<string, SecurityStateBySlug>> {
  const { data } = await admin
    .from("agent_jobs")
    .select("spec_slug, status, instructions, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "security-review")
    .order("created_at", { ascending: false })
    .limit(1000);
  const map: Record<string, SecurityStateBySlug> = {};
  const runningSet: ReadonlySet<string> = new Set(RUNNING_SECURITY_STATUSES);
  const surfacedSet: ReadonlySet<string> = new Set(SURFACED_SECURITY_STATUSES);
  for (const row of (data ?? []) as Array<{ spec_slug: string; status: string; instructions?: string }>) {
    const slug = String(row.spec_slug || "");
    // Exclude infra dep-watch jobs by IDENTITY: the sentinel slug OR the dep-watch mode. A real
    // `diff`/`branch` review of the `security-dep-upgrades` fix spec is NOT infra — it rolls up.
    let mode = "";
    try {
      mode = String(JSON.parse(String(row.instructions || "{}")).mode || "");
    } catch {
      /* not JSON — treat as a non-dep-watch (diff) review */
    }
    if (!slug || slug === SECURITY_DEP_WATCH_SLUG || mode === "dep-watch") continue;
    const cur = (map[slug] ||= { live: false, surfaced: false, completedClean: false });
    if (runningSet.has(row.status)) cur.live = true;
    else if (surfacedSet.has(row.status)) cur.surfaced = true;
    else if (row.status === "completed") cur.completedClean = true;
  }
  // `completedClean` is the CLEAN terminal state — a live/surfaced job for the same slug overrides it
  // (the Security node can never read "done" while a routed fix or running review is still open).
  for (const s of Object.values(map)) {
    if (s.live || s.surfaced) s.completedClean = false;
  }
  return map;
}

/**
 * SLUG-SCOPED security-review rollup — the single-spec fast path for the investigation SDK
 * ([[spec-investigation]] / Mario). Identical `live`/`surfaced`/`completedClean` semantics as
 * [[getSecurityStateBySlug]], but reads ONLY this slug's rows instead of scanning the whole
 * workspace (the board path pulls up to 1000 rows to build a Record; a single-spec investigate
 * doesn't need that). Returns the all-false absent state when no security-review row exists yet.
 */
export async function getSecurityStateForSlug(
  admin: Admin,
  workspaceId: string,
  slug: string,
): Promise<SecurityStateBySlug> {
  const state: SecurityStateBySlug = { live: false, surfaced: false, completedClean: false };
  if (!slug || slug === SECURITY_DEP_WATCH_SLUG) return state;
  const { data } = await admin
    .from("agent_jobs")
    .select("status, instructions")
    .eq("workspace_id", workspaceId)
    .eq("kind", "security-review")
    .eq("spec_slug", slug)
    .order("created_at", { ascending: false })
    .limit(200);
  const runningSet: ReadonlySet<string> = new Set(RUNNING_SECURITY_STATUSES);
  const surfacedSet: ReadonlySet<string> = new Set(SURFACED_SECURITY_STATUSES);
  for (const row of (data ?? []) as Array<{ status: string; instructions?: string }>) {
    let mode = "";
    try {
      mode = String(JSON.parse(String(row.instructions || "{}")).mode || "");
    } catch {
      /* not JSON — a diff review */
    }
    if (mode === "dep-watch") continue; // infra scan, not a per-spec gate
    if (runningSet.has(row.status)) state.live = true;
    else if (surfacedSet.has(row.status)) state.surfaced = true;
    else if (row.status === "completed") state.completedClean = true;
  }
  if (state.live || state.surfaced) state.completedClean = false;
  return state;
}

/** Per-branch security-review rollup — same shape as [[SecurityStateBySlug]] but keyed to the build's
 * `claude/*` branch (pre-merge `branch`-mode jobs carry `spec_branch === branch`). The pre-merge M4
 * promote gate reads this. */
export interface SecurityStateForBranch {
  /** Any security-review job for this branch in `queued`/`claimed`/`building`/`needs_input`/`queued_resume` — the review is running. */
  live: boolean;
  /** Any security-review job for this branch in `needs_approval` (a routed real-vuln fix) or `needs_attention` (a needs-human finding) — surfaced to the owner. */
  surfaced: boolean;
  /** A `completed` security-review job exists for this branch AND no live/surfaced sibling — clean terminal state. */
  completedClean: boolean;
}

/**
 * Per-branch security-review rollup ([[../specs/security-test-on-preview-pre-merge]] Phase 3) — the
 * pre-merge **M4 promote gate** reads this. Same `live`/`surfaced`/`completedClean` definition as
 * [[getSecurityStateBySlug]] (a `completed` job exists AND no live/surfaced sibling) so the pre-merge
 * gate and the post-ship fold gate ([[../specs/build-card-lifecycle-timeline]] Phase 3 / [[spec-test-runs]]
 * `getAutoFoldEligibleSlugs`) can never disagree on what "security green" means. Branch-mode jobs carry
 * `spec_branch === branch`; the rollup is scoped to that column. A branch with no security-review record
 * yet returns all-false (NOT clean) — the pre-merge enqueue (Phase 1) hasn't fired, or the box hasn't
 * reached a verdict; same absence-≠-clean rule the post-ship gate applies.
 */
export async function getSecurityStateForBranch(admin: Admin, branch: string): Promise<SecurityStateForBranch> {
  const state: SecurityStateForBranch = { live: false, surfaced: false, completedClean: false };
  const b = String(branch || "").trim();
  if (!b) return state;
  const { data } = await admin
    .from("agent_jobs")
    .select("status")
    .eq("kind", "security-review")
    .eq("spec_branch", b)
    .order("created_at", { ascending: false })
    .limit(200);
  const runningSet: ReadonlySet<string> = new Set(RUNNING_SECURITY_STATUSES);
  const surfacedSet: ReadonlySet<string> = new Set(SURFACED_SECURITY_STATUSES);
  for (const row of (data ?? []) as Array<{ status: string }>) {
    if (runningSet.has(row.status)) state.live = true;
    else if (surfacedSet.has(row.status)) state.surfaced = true;
    else if (row.status === "completed") state.completedClean = true;
  }
  // Mirrors getSecurityStateBySlug: a live/surfaced sibling for the same branch overrides the clean
  // terminal — the gate can never read "green" while a routed fix or running review is still open.
  // The two helpers MUST agree on the clean definition (the pre-merge gate and the post-ship fold gate
  // are the same supervision rail; if they disagreed, a branch could promote past a finding the fold
  // gate would block, or vice versa).
  if (state.live || state.surfaced) state.completedClean = false;
  return state;
}

/**
 * The "security-test green for this branch" signal the **M4 pre-merge promote gate** reads
 * ([[../specs/security-test-on-preview-pre-merge]] Phase 3). Green iff [[getSecurityStateForBranch]]'s
 * `completedClean` is true — the SAME `completedClean` definition the post-ship fold gate reuses via
 * [[getSecurityStateBySlug]] ([[spec-test-runs]] `getAutoFoldEligibleSlugs`), so the two gates can never
 * disagree on what "security green" means. A branch with no security-review record yet is NOT green
 * (defer; the post-ship gate is the same — absence ≠ clean).
 */
export async function isSecurityGreenForBranch(admin: Admin, branch: string): Promise<boolean> {
  const state = await getSecurityStateForBranch(admin, branch);
  return state.completedClean;
}

// ── Vault's full results log (dashboard/security-tests) ─────────────────────────

/** The verdict surfaced per review row on the Security tests log — Vault's three classifications
 * plus the terminal/in-flight job states (clean = a completed review that surfaced nothing). */
export type SecurityReviewVerdict = SecurityVerdict | "clean" | "running" | "failed";

/** One row of Vault's security-review log — a single review of one merged diff (or the dep-watch scan). */
export interface SecurityReviewLogItem {
  jobId: string;
  /** the reviewed merged spec slug (or [[SECURITY_DEP_WATCH_SLUG]] for the CVE scan). */
  specSlug: string;
  /** the reviewed spec's human title, when the slug resolves to a real spec (else null). */
  specTitle: string | null;
  mode: "diff" | "dep-watch";
  verdict: SecurityReviewVerdict;
  /** raw agent_jobs.status (for the curious / debugging). */
  status: string;
  /** the box's plain-text finding + classification (log_tail). */
  finding: string;
  /** the authored fix/upgrade spec slug (set only for a routed real-vuln fix). */
  fixSlug: string | null;
  prNumber: number | null;
  createdAt: string;
}

/** Derive the log verdict from a job's status + finding text. Surfaced jobs carry the real verdict in
 * their status; a completed job's verdict is parsed off the log_tail prefix (`clean`/`false-positive`). */
function deriveReviewVerdict(status: string, finding: string, fixSlug: string | null): SecurityReviewVerdict {
  if (status === "needs_approval") return fixSlug ? "real-vuln" : "needs-human";
  if (status === "needs_attention") return "needs-human";
  if (status === "failed") return "failed";
  if (status === "completed") {
    return /^\s*false-positive\b/i.test(finding) ? "false-positive" : "clean";
  }
  return "running";
}

/**
 * READ-ONLY: Vault's full security-review log for a workspace — every review she's run (clean ones
 * included), newest-first, for the dashboard/security-tests surface. Enriches each row with the
 * reviewed spec's title when the slug resolves to a real [[specs]] row. Bounded.
 */
export async function listSecurityReviews(
  admin: Admin,
  workspaceId: string,
  limit = 200,
): Promise<SecurityReviewLogItem[]> {
  const { data } = await admin
    .from("agent_jobs")
    .select("id, spec_slug, status, instructions, pending_actions, log_tail, pr_number, created_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "security-review")
    .order("created_at", { ascending: false })
    .limit(Math.min(limit, 500));

  const rows = (data ?? []) as Array<Record<string, unknown>>;

  // Batch-resolve spec titles for the reviewed slugs (skip the dep-watch INFRA sentinel only — it's not a
  // real spec row; `security-dep-upgrades` IS a real shippable fix spec, so resolve its title).
  const slugs = Array.from(
    new Set(
      rows
        .map((r) => String(r.spec_slug || ""))
        .filter((s) => s && s !== SECURITY_DEP_WATCH_SLUG),
    ),
  );
  const titleBySlug = new Map<string, string>();
  if (slugs.length) {
    const { data: specs } = await admin
      .from("specs")
      .select("slug, title")
      .eq("workspace_id", workspaceId)
      .in("slug", slugs);
    for (const s of (specs ?? []) as Array<{ slug: string; title: string | null }>) {
      if (s.title) titleBySlug.set(s.slug, s.title);
    }
  }

  return rows.map((row) => {
    const status = String(row.status || "");
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
    const finding = typeof row.log_tail === "string" ? row.log_tail : "";
    const specSlug = String(row.spec_slug || "");
    return {
      jobId: String(row.id),
      specSlug,
      specTitle: titleBySlug.get(specSlug) ?? null,
      mode,
      verdict: deriveReviewVerdict(status, finding, fixSlug),
      status,
      finding,
      fixSlug,
      prNumber: typeof row.pr_number === "number" ? row.pr_number : null,
      createdAt: String(row.created_at || ""),
    };
  });
}

/** Lightweight count of SURFACED security reviews (a routed real-vuln fix or a needs-human finding)
 * awaiting the owner — the sidebar badge. Clean reviews never count. */
export async function countOpenSecurityReviews(admin: Admin, workspaceId: string): Promise<number> {
  const { count } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("kind", "security-review")
    .in("status", SURFACED_SECURITY_STATUSES as unknown as string[]);
  return count ?? 0;
}
