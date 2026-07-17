import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import { AUTO_MERGE_GATE_LOOP_ID } from "@/lib/control-tower/registry";
import { findMergedSiblingBuild, handleAutoMergedBuildBranch, getBranchBuildSuccess } from "@/lib/agent-jobs";
import { openDeployWatch } from "@/lib/deploy-guardian";
import { getSpecTestStateForBranch } from "@/lib/spec-test-runs";
import { isSecurityGreenForBranch } from "@/lib/security-agent";
import { recordHumanOnlyPromoteAdvisory } from "@/lib/director-activity";
import { isSpecAccumulationComplete } from "@/lib/specs-table";
import { isEffectivelyEnabled } from "@/lib/control-tower/legacy-switch-compat";

/**
 * github-pr-resolve — the detection + enqueue half of the Dirty-PR Resolver Agent
 * (docs/brain/specs/dirty-pr-resolver-agent.md). The GitHub webhook (/api/webhooks/github) calls
 * `detectAndEnqueueDirtyPrs` on a push to `main` (the event that makes other PRs conflict) and on
 * pull_request opened/synchronize/reopened. It lists open `claude/*` PRs, checks each `mergeable`
 * (GitHub recomputes async after a push, so a null result is polled briefly), and for any that just
 * became CONFLICTING (`mergeable === false`) enqueues ONE `pr-resolve` agent_jobs row — deduped, so a
 * PR already being resolved is skipped. The box worker (`runPrResolveJob`) does the actual merge.
 *
 * Repo-level webhook → the job is attached to the build-console workspace (the one that runs builds).
 */

type Admin = ReturnType<typeof createAdminClient>;

const GH_REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";

function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

// The statuses a pr-resolve job occupies while in flight — dedupe against these so one PR is never
// resolved by two jobs at once (mirrors enqueueMigrationFixJob / queueRoadmapBuild).
const ACTIVE_JOB_STATUSES = [
  "queued",
  "queued_resume",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
];

/**
 * dirty-pr-resolver-duplicate-detection (Phase 1) — backstop cap. A single PR must never spawn unbounded
 * pr-resolve jobs: once this many pr-resolve jobs (ANY status) exist for a PR, stop enqueueing and surface
 * it to the owner instead of looping forever. The already-merged-duplicate detector catches the known
 * unresolvable case up front; this caps any FUTURE unresolvable case so it can't burn tokens indefinitely.
 */
const MAX_PR_RESOLVE_ATTEMPTS = 3;

/**
 * pr-resolve-retry-cap-counts-parked-attempts (Phase 1): the surfaced-cap sentinel row inserted by
 * `surfaceExhaustedPrResolve` has this exact error prefix. It is a MARKER that the owner has been
 * notified — NOT an attempt — so the genuine-attempt counter excludes it. Every other `needs_attention`
 * pr-resolve row (advisory-supersede park from builder-worker.ts, etc.) DID run the resolver to a verdict
 * and MUST count toward the cap; otherwise the standing-pass dirty-PR backstop re-enqueues every pass
 * (the 7h / 61-job storm on #1893 — the cap was structurally unreachable).
 */
const EXHAUSTED_SENTINEL_ERROR_PREFIX = "pr-resolve retry cap reached";

/**
 * Regex identifying INFRASTRUCTURE failures (`git worktree add` blew up, a push/fetch died, the box
 * crashed before the resolver started). An infra failure is NOT the resolver giving up on a hard
 * conflict; counting it burns the 3-strike human-escalation budget on a box bug (see growth-adopt-
 * storefront-optimizer #878 + kpi-audit #847). Exported for the pure counting helper's tests.
 */
export const PR_RESOLVE_INFRA_FAILURE_RE =
  /worktree add failed|git (?:push|fetch|checkout|merge|worktree) failed|ENOSPC|could not lock|no space left/i;

/**
 * Pure decision helper for the pr-resolve retry cap. Counts prior pr-resolve rows that represent a
 * GENUINE resolver attempt against a hard conflict — i.e. rows that ran the resolver to a verdict.
 * Excluded:
 *   - the surfaced-cap sentinel row (`needs_attention` with the retry-cap-reached error prefix) — a
 *     marker, not an attempt (pr-resolve-retry-cap-counts-parked-attempts Phase 1).
 *   - `failed` rows whose error matches `PR_RESOLVE_INFRA_FAILURE_RE` (worktree add / git push
 *     failed / ENOSPC …) — a box bug, not a resolve verdict; must not burn the cap.
 * Included (the fix): `needs_attention` rows parked from advisory-supersede in builder-worker.ts.
 * Those DID run the resolver's static pre-flight to a verdict of "needs human"; counting them makes
 * the cap trip and stops the standing-pass dirty-PR backstop from re-enqueuing forever (#1893).
 */
export function countGenuinePrResolveAttempts(
  rows: ReadonlyArray<{ status: string; error: string | null }>,
): number {
  return rows.filter((row) => {
    if (
      row.status === "needs_attention" &&
      (row.error ?? "").startsWith(EXHAUSTED_SENTINEL_ERROR_PREFIX)
    ) {
      return false; // the surfaced sentinel — a marker, not an attempt
    }
    if (row.status === "failed" && PR_RESOLVE_INFRA_FAILURE_RE.test(row.error ?? "")) {
      return false; // box/infra, not a resolve verdict
    }
    return true;
  }).length;
}

/** Exported for unit tests. */
export const PR_RESOLVE_MAX_ATTEMPTS_FOR_TESTS = MAX_PR_RESOLVE_ATTEMPTS;

/**
 * Verify the `X-Hub-Signature-256` header GitHub sends on a webhook delivery. GitHub signs the raw
 * body with HMAC-SHA256(secret, body) and sends `sha256=<hex>`. Constant-time compare; reject a
 * missing/malformed header, an unconfigured secret, or a length/digest mismatch. Mirrors
 * `verifyMetaWebhookSignature` (the raw bytes as received MUST be used — JSON re-encoding breaks it).
 */
export function verifyGithubWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!signatureHeader || !secret) return false;
  const [algo, providedHex] = signatureHeader.split("=");
  if (algo !== "sha256" || !providedHex) return false;

  const computed = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  if (computed.length !== providedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(providedHex, "hex"));
  } catch {
    return false;
  }
}

async function gh(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | Array<Record<string, unknown>> }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : {} };
}

/**
 * Resolve the `claude/build-*` branch whose HEAD is `sha` (GitHub `branches-where-head`). Used by the
 * deployment-ready webhook to map a Vercel preview deploy (which GitHub reports by commit SHA, not branch)
 * back to its build branch. Returns null when no build branch heads at that commit — a STALE/superseded
 * deploy (a newer phase already pushed), or the branch already merged/deleted → correctly skipped.
 */
export async function resolveBuildBranchForSha(sha: string): Promise<string | null> {
  if (!sha) return null;
  try {
    const r = await gh("GET", `/repos/${GH_REPO}/commits/${encodeURIComponent(sha)}/branches-where-head`);
    if (!r.ok || !Array.isArray(r.json)) return null;
    const names = (r.json as Array<{ name?: string }>).map((b) => b?.name).filter((n): n is string => !!n);
    return names.find((n) => n.startsWith("claude/build-")) ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GitHub computes `mergeable` lazily — the value is `null` on the list endpoint and right after a
 * push, then settles to `true|false` a moment later. GET the single PR a few times until it settles
 * (bounded so the webhook never hangs); `null` after the budget means "unknown" → leave it alone (a
 * later event re-checks it). Returns the PR object on the final read.
 */
async function fetchMergeable(
  prNumber: number,
  maxAttempts = 4,
  delayMs = 1200,
): Promise<{ mergeable: boolean | null; pr: Record<string, unknown> }> {
  let pr: Record<string, unknown> = {};
  for (let i = 0; i < maxAttempts; i++) {
    const r = await gh("GET", `/repos/${GH_REPO}/pulls/${prNumber}`);
    pr = (r.json || {}) as Record<string, unknown>;
    if (!r.ok) return { mergeable: null, pr };
    const m = pr.mergeable;
    if (typeof m === "boolean") return { mergeable: m, pr };
    if (pr.state !== "open" || pr.merged) return { mergeable: null, pr };
    if (i < maxAttempts - 1) await sleep(delayMs);
  }
  return { mergeable: null, pr };
}

/**
 * The workspace a repo-level pr-resolve job is attached to: the build-console workspace (the one that
 * actually runs builds = has agent_jobs rows). Falls back to the first workspace. Mirrors the
 * system-level enqueue pattern (spec-test-cron / review-tagging).
 */
async function resolveBuildWorkspaceId(admin: Admin): Promise<string | null> {
  const { data: jobRow } = await admin
    .from("agent_jobs")
    .select("workspace_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (jobRow?.workspace_id) return jobRow.workspace_id as string;
  const { data: ws } = await admin.from("workspaces").select("id").limit(1).maybeSingle();
  return (ws?.id as string) || null;
}

/** Stable dedupe key for a PR (one pr-resolve job per PR at a time). */
function prSpecSlug(prNumber: number): string {
  return `pr-${prNumber}`;
}

/**
 * dirty-pr-resolver-duplicate-detection (Phase 1): is this conflicting PR's work ALREADY MERGED via a
 * sibling build? Maps the PR branch → its originating `kind='build'` job (spec_slug + workspace) → checks
 * for a SIBLING build of the same spec that already merged (same phase scope). Such a PR is unresolvable
 * by definition — its diff is already on `main`, so rebasing/merging main just re-conflicts. Returns the
 * merged sibling (so the caller can close+stop with a clear comment) or null (resolve normally).
 *
 * Branch-keyed (not slug-keyed) because the webhook only knows the PR/branch; we never guess the spec from
 * the branch name — we read the build job that created it. If no build job maps to the branch, returns
 * null (can't prove it's a dup → let the normal resolver handle it).
 */
export async function findAlreadyMergedDuplicate(
  admin: Admin,
  branch: string,
): Promise<{ specSlug: string; mergedBranch: string | null; mergedPr: number | null } | null> {
  if (!branch || !branch.startsWith("claude/")) return null;
  const { data: buildJob } = await admin
    .from("agent_jobs")
    .select("spec_slug, workspace_id, instructions")
    .eq("spec_branch", branch)
    .eq("kind", "build")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const specSlug = buildJob?.spec_slug as string | undefined;
  const workspaceId = buildJob?.workspace_id as string | undefined;
  if (!specSlug || !workspaceId) return null;

  const sibling = await findMergedSiblingBuild(workspaceId, specSlug, {
    excludeBranch: branch,
    instructions: (buildJob?.instructions as string | null) ?? null,
    admin,
  });
  if (!sibling) return null;
  return { specSlug, mergedBranch: sibling.spec_branch, mergedPr: sibling.pr_number };
}

/**
 * pr-resolve-supersede-action-authorization: fresh-read the PR + verify state/ref/repository/SHA
 * still match the analysis snapshot, immediately before a mutation. Fail-closed if anything drifted
 * (a fork PR whose head ref matches an internal claude/* branch, a re-push between analysis and
 * mutation, or a repo/branch rename). Every code path that PATCHes or DELETEs on GitHub must pass
 * through this gate — never mutate on stale evidence.
 */
async function reverifyPrHeadForMutation(
  prNumber: number,
  expectedBranch: string,
  expectedHeadSha: string,
): Promise<{ ok: boolean; reason: string }> {
  const r = await gh("GET", `/repos/${GH_REPO}/pulls/${prNumber}`);
  if (!r.ok) return { ok: false, reason: `pr fetch failed (${r.status})` };
  const pr = r.json as {
    state?: string;
    merged?: boolean;
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    base?: { repo?: { full_name?: string } };
  };
  if (pr.state !== "open" || pr.merged) return { ok: false, reason: `state=${pr.state} merged=${pr.merged}` };
  const headRepo = pr.head?.repo?.full_name;
  const baseRepo = pr.base?.repo?.full_name;
  if (headRepo !== GH_REPO) return { ok: false, reason: `head.repo=${headRepo} (expected ${GH_REPO})` };
  if (baseRepo !== GH_REPO) return { ok: false, reason: `base.repo=${baseRepo} (expected ${GH_REPO})` };
  if (pr.head?.ref !== expectedBranch) return { ok: false, reason: `head.ref=${pr.head?.ref} (expected ${expectedBranch})` };
  if (pr.head?.sha !== expectedHeadSha) return { ok: false, reason: `head.sha=${pr.head?.sha?.slice(0, 8)} (expected ${expectedHeadSha.slice(0, 8)})` };
  return { ok: true, reason: "ok" };
}

/**
 * Verify the internal branch ref on GitHub is still at the exact SHA we authorized against. Called
 * between PATCH-close and DELETE-branch so a race that re-pushed the branch (fork PR named
 * claude/*, human amend on the internal branch) causes a fail-closed no-delete.
 */
async function reverifyBranchRefForDelete(
  branch: string,
  expectedHeadSha: string,
): Promise<{ ok: boolean; reason: string }> {
  const r = await gh("GET", `/repos/${GH_REPO}/git/refs/heads/${encodeURIComponent(branch)}`);
  if (!r.ok) return { ok: false, reason: `ref fetch failed (${r.status})` };
  const obj = (r.json as { object?: { sha?: string } }).object;
  if (obj?.sha !== expectedHeadSha) return { ok: false, reason: `ref.sha=${obj?.sha?.slice(0, 8)} (expected ${expectedHeadSha.slice(0, 8)})` };
  return { ok: true, reason: "ok" };
}

/**
 * Close a duplicate claude/* PR (+ delete its branch) with an explanatory comment, instead of resolving it.
 * Used when the PR's work already merged via a sibling — there is nothing to resolve.
 *
 * pr-resolve-supersede-action-authorization: `expectedHeadSha` is REQUIRED. Immediately before PATCH we
 * re-fetch the PR and confirm state=open / head.repo=REPO / head.ref=branch / head.sha=expectedHeadSha —
 * any drift is fail-closed (no mutation). Between PATCH-close and DELETE-branch we also re-read the branch
 * ref and confirm it still sits at expectedHeadSha (a race that re-pushed the branch causes a no-delete,
 * so we never delete a branch that has moved). The comment is best-effort AFTER the authorized close.
 */
export async function closeDuplicatePr(
  prNumber: number,
  branch: string,
  comment: string,
  opts: { expectedHeadSha: string },
): Promise<{ ok: boolean; reason?: string }> {
  const expectedHeadSha = opts.expectedHeadSha;
  const verify = await reverifyPrHeadForMutation(prNumber, branch, expectedHeadSha);
  if (!verify.ok) return { ok: false, reason: `authorization-drift: ${verify.reason}` };
  const closed = await gh("PATCH", `/repos/${GH_REPO}/pulls/${prNumber}`, { state: "closed" });
  if (!closed.ok) return { ok: false, reason: `patch failed (${closed.status})` };
  try {
    await gh("POST", `/repos/${GH_REPO}/issues/${prNumber}/comments`, { body: comment });
  } catch {
    /* best-effort comment (posted AFTER the authorized close so we never leave a comment on a stale PR) */
  }
  const refOk = await reverifyBranchRefForDelete(branch, expectedHeadSha);
  if (!refOk.ok) return { ok: true, reason: `closed; branch delete skipped: ${refOk.reason}` };
  try {
    await gh("DELETE", `/repos/${GH_REPO}/git/refs/heads/${encodeURIComponent(branch)}`);
  } catch {
    /* best-effort branch cleanup (404/422 = already gone / protected) */
  }
  return { ok: true };
}

/**
 * pr-resolve-fold-closes-orphan-pr (Phase 2) — close a still-open claude/* PR whose spec was folded
 * or shipped. Called from [[cancelJobsForArchivedSpecs]] once we have identified an archived-spec
 * build job whose PR is still open (the orphan). Idempotent + safe:
 *
 *   1. GET the PR fresh. If it's ALREADY CLOSED or MERGED → return ok=true, reason='not-open'
 *      (a common no-op; the human merged/closed it before the fold path caught up).
 *   2. Read the current head SHA off the same fetch and pass it as `expectedHeadSha` to
 *      [[closeDuplicatePr]] — same authorization contract (state/repo/branch/SHA re-verify
 *      immediately before PATCH; ref-SHA re-verify before branch DELETE). A concurrent push during
 *      the tiny window between GET and PATCH fails-closed on the re-verify (no mutation on stale
 *      state) — the caller treats fail-closed as a no-op and moves on; the next fold-reconcile pass
 *      picks it up.
 *   3. Comment cites the folded spec so the reader sees WHY the auto-close happened.
 *
 * The returned `reason` values the caller renders:
 *   - `ok=true, reason=undefined` → closed + branch deleted
 *   - `ok=true, reason='not-open'` → PR was already closed/merged (idempotent no-op)
 *   - `ok=true, reason='closed; branch delete skipped: …'` → PATCH-close succeeded, branch DELETE skipped
 *   - `ok=false, reason=…` → nothing mutated (auth-drift, GH read failure, PATCH failed)
 */
export async function closeArchivedSpecPr(
  prNumber: number,
  branch: string,
  specSlug: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!ghToken()) return { ok: false, reason: "no github token" };
  let pr: { state?: string; merged?: boolean; head?: { ref?: string; sha?: string } };
  try {
    const r = await gh("GET", `/repos/${GH_REPO}/pulls/${prNumber}`);
    if (!r.ok) return { ok: false, reason: `pr fetch failed (${r.status})` };
    pr = r.json as { state?: string; merged?: boolean; head?: { ref?: string; sha?: string } };
  } catch (e) {
    return { ok: false, reason: `pr fetch threw: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Idempotent: already closed/merged → no-op (a human, closeDuplicatePr, or a merge-into-main path
  // beat us to it). Same-shape return as `ok=true` so the caller doesn't error-log a normal race.
  if (pr.state !== "open" || pr.merged) return { ok: true, reason: "not-open" };
  const headSha = pr.head?.sha;
  if (typeof headSha !== "string" || headSha.length < 40) {
    return { ok: false, reason: "head.sha missing on fresh read" };
  }
  const comment = `Closing as an orphan: this spec (\`${specSlug}\`) was folded/shipped — its brain entry was archived, so this PR's build has nothing left to merge into a live spec. Auto-closed by the archived-spec cleanup (pr-resolve-fold-closes-orphan-pr).`;
  return closeDuplicatePr(prNumber, branch, comment, { expectedHeadSha: headSha });
}

/**
 * Enqueue ONE `pr-resolve` job for a dirty PR. Idempotent: no-op if an active pr-resolve job already
 * exists for this PR (so a burst of push + synchronize events for the same PR enqueues once).
 */
export async function enqueuePrResolveJob(
  admin: Admin,
  input: { workspaceId: string; prNumber: number; branch: string; reason?: string },
): Promise<{ enqueued: boolean; reason?: string }> {
  const slug = prSpecSlug(input.prNumber);
  const { data: existing } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "pr-resolve")
    .eq("spec_slug", slug)
    .in("status", ACTIVE_JOB_STATUSES)
    .limit(1)
    .maybeSingle();
  if (existing) return { enqueued: false, reason: "active job exists" };

  // Retry cap (dirty-pr-resolver-duplicate-detection Phase 1): stop looping after MAX_PR_RESOLVE_ATTEMPTS
  // GENUINE resolve attempts — surface to the owner once and do NOT enqueue again.
  //
  // pr-resolve-cap-ignores-infra-failures + pr-resolve-retry-cap-counts-parked-attempts (Phase 1):
  // count only attempts that actually RAN the resolver to a verdict. See countGenuinePrResolveAttempts
  // for the full inclusion/exclusion rules. Advisory-supersede parks (needs_attention rows from
  // builder-worker.ts) DID run the resolver to a verdict and MUST count — otherwise the standing-pass
  // dirty-PR backstop re-enqueues every pass and the cap is structurally unreachable (#1893 storm).
  // Infra failures (worktree add failed, git push failed, ENOSPC) and the retry-cap sentinel do NOT.
  const { data: priorJobs } = await admin
    .from("agent_jobs")
    .select("status, error")
    .eq("workspace_id", input.workspaceId)
    .eq("kind", "pr-resolve")
    .eq("spec_slug", slug);
  const genuineAttempts = countGenuinePrResolveAttempts(
    (priorJobs ?? []) as Array<{ status: string; error: string | null }>,
  );
  if (genuineAttempts >= MAX_PR_RESOLVE_ATTEMPTS) {
    await surfaceExhaustedPrResolve(admin, input.workspaceId, input.prNumber, genuineAttempts);
    return { enqueued: false, reason: `retry cap reached (${genuineAttempts} attempts) — surfaced to owner` };
  }

  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: input.workspaceId,
    spec_slug: slug,
    spec_branch: input.branch,
    kind: "pr-resolve",
    status: "queued",
    pr_number: input.prNumber,
    instructions: JSON.stringify({
      pr_number: input.prNumber,
      branch: input.branch,
      reason: input.reason || "PR became CONFLICTING",
    }),
  });
  if (error) return { enqueued: false, reason: error.message };
  return { enqueued: true };
}

/**
 * Surface a PR that exhausted the pr-resolve retry cap to the owner — once. Idempotent: leaves a single
 * `needs_attention` pr-resolve sentinel row per PR (the marker that we've already escalated), so a burst of
 * webhook events past the cap notifies the owner only the first time. Best-effort throughout.
 */
async function surfaceExhaustedPrResolve(
  admin: Admin,
  workspaceId: string,
  prNumber: number,
  attempts: number,
): Promise<void> {
  const slug = prSpecSlug(prNumber);
  try {
    const { data: alreadySurfaced } = await admin
      .from("agent_jobs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("kind", "pr-resolve")
      .eq("spec_slug", slug)
      .eq("status", "needs_attention")
      .limit(1)
      .maybeSingle();
    if (alreadySurfaced) return; // already escalated — don't re-notify

    const prUrl = `https://github.com/${GH_REPO}/pull/${prNumber}`;
    await admin.from("agent_jobs").insert({
      workspace_id: workspaceId,
      spec_slug: slug,
      kind: "pr-resolve",
      status: "needs_attention",
      pr_number: prNumber,
      error: `pr-resolve retry cap reached (${attempts} attempts) — needs a human`,
      log_tail: `PR #${prNumber} could not be auto-resolved after ${attempts} pr-resolve attempt(s); stopped retrying to avoid an unresolvable loop.`,
    });
    try {
      const { notifyOpsAlert } = await import("@/lib/notify-ops-alert");
      await notifyOpsAlert(workspaceId, {
        title: `Dirty-PR resolver: PR #${prNumber} gave up after ${attempts} attempts`,
        severity: "warning",
        lines: [
          `This PR could not be auto-resolved after ${attempts} pr-resolve attempt(s). Stopped retrying to avoid an unresolvable loop — a human should resolve or close it.`,
          prUrl,
        ],
      });
    } catch {
      /* slack best-effort */
    }
  } catch (e) {
    console.error(`[pr-resolve] surfaceExhausted PR #${prNumber} failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * pr-resolve-park-clears-on-pr-merged — one-shot PR-state read for the approval-inbox stale-park
 * reconciler + serialize-goal-member-spec-builds Phase 2's goal-member DIRTY detector. Returns
 * `{ ok:true, merged, state, closedAt, mergeableState, baseRef }` on a positive read; `{ ok:false }`
 * on ANY failure (no token, non-2xx, malformed body, network throw) so callers fail CLOSED — a null
 * read never clears a live park card and (Phase 2) never re-drives a PR whose GitHub state is unknown.
 *
 * `mergeableState` mirrors the REST API's `mergeable_state` field (values: `clean` / `unstable` /
 * `dirty` / `behind` / `blocked` / `unknown`). `dirty` = literal merge conflict; `behind` = base branch
 * has advanced past this PR's merge base (the "goal branch advanced under a member PR" case). Phase 2's
 * reconciler acts on either as "needs re-drive". `baseRef` carries `pr.base.ref` so the reconciler /
 * pr-resolver can merge THAT branch (a goal-member's base is `goal/{slug}`, not main).
 *
 * Not a poll (unlike `fetchMergeable`); the caller doesn't need `mergeable` to settle — it only asks
 * "is this PR still open, and if so what's its current merge state." See
 * [[../../docs/brain/libraries/approval-inbox.md]].
 */
export async function getPr(
  prNumber: number,
): Promise<
  | { ok: true; merged: boolean; state: string; closedAt: string | null; mergeableState: string | null; baseRef: string | null }
  | { ok: false }
> {
  if (!ghToken()) return { ok: false };
  try {
    const r = await gh("GET", `/repos/${GH_REPO}/pulls/${prNumber}`);
    if (!r.ok) return { ok: false };
    const body = (r.json || {}) as Record<string, unknown>;
    const state = typeof body.state === "string" ? body.state : "";
    const merged = body.merged === true;
    const closedAt = typeof body.closed_at === "string" ? body.closed_at : null;
    const mergeableState = typeof body.mergeable_state === "string" ? body.mergeable_state : null;
    const baseRef = typeof (body.base as { ref?: string } | undefined)?.ref === "string" ? (body.base as { ref: string }).ref : null;
    if (!state) return { ok: false };
    return { ok: true, merged, state, closedAt, mergeableState, baseRef };
  } catch {
    return { ok: false };
  }
}

/**
 * mario-detects-job-and-pr-wedges Phase 3 — read a PR's OPEN head shape (ref + sha + repo). Sibling
 * of `getPr` that ALSO returns the internal-repo head ref/sha so a caller can pass them straight to
 * `closeDuplicatePr({ expectedHeadSha })`. Fail-closed: any GitHub error → `{ok:false}`; a PR that
 * is already closed / merged / on a fork head returns `{ok:false}` too, so a caller never receives
 * a head SHA for a state that isn't safe to authorize a mutation against.
 */
export async function getPrHead(
  prNumber: number,
): Promise<{ ok: true; state: string; headRef: string; headSha: string } | { ok: false; reason: string }> {
  if (!ghToken()) return { ok: false, reason: "no gh token" };
  try {
    const r = await gh("GET", `/repos/${GH_REPO}/pulls/${prNumber}`);
    if (!r.ok) return { ok: false, reason: `pr fetch failed (${r.status})` };
    const pr = r.json as {
      state?: string;
      merged?: boolean;
      head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    };
    if (pr.state !== "open" || pr.merged) return { ok: false, reason: `state=${pr.state} merged=${pr.merged}` };
    const headRepo = pr.head?.repo?.full_name;
    if (headRepo !== GH_REPO) return { ok: false, reason: `head.repo=${headRepo} (expected ${GH_REPO})` };
    const headRef = pr.head?.ref;
    const headSha = pr.head?.sha;
    if (typeof headRef !== "string" || !headRef) return { ok: false, reason: "head.ref missing" };
    if (typeof headSha !== "string" || !headSha) return { ok: false, reason: "head.sha missing" };
    return { ok: true, state: pr.state, headRef, headSha };
  } catch {
    return { ok: false, reason: "fetch threw" };
  }
}

/**
 * accumulation-stamp-gap-and-rollback-guard P2 — list the set of branch refs backing an OPEN claude/build-*
 * PR right now. The stuck-accumulation backstop uses this to decide "is a build branch NOT already visible as
 * an open PR?" (the wedge signature). Returns `null` on ANY GitHub failure (no token, list failed, bad payload)
 * so the caller fails CLOSED — never guess a wedge and never stamp a phase without a live PR read confirming
 * absence. One page (per_page=100) matches the existing `detectAndEnqueueDirtyPrs` scan; the workspace's build
 * volume sits well under that cap.
 */
export async function listOpenClaudeBuildBranches(): Promise<Set<string> | null> {
  if (!ghToken()) return null;
  const list = await gh("GET", `/repos/${GH_REPO}/pulls?state=open&per_page=100`);
  if (!list.ok || !Array.isArray(list.json)) return null;
  const out = new Set<string>();
  for (const p of list.json as Array<Record<string, unknown>>) {
    const ref = (p.head as { ref?: string } | undefined)?.ref;
    if (typeof ref === "string" && ref.startsWith("claude/build-")) out.add(ref);
  }
  return out;
}

/**
 * accumulation-stamp-gap-and-rollback-guard P2 — read the branch's head SHA + the set of `Phase: N` trailer
 * positions committed on `main..branch`. Mirrors P1's finalize scan (line-anchored `Phase: N` per commit
 * message on origin/main..HEAD) — the same trailer convention `queueNextChainedPhase` writes into every
 * scoped-instruction commit — but over the GitHub compare API so it runs from the standing pass without a
 * local checkout. Returns `null` on ANY failure (no token, missing branch, bad payload) so the caller fails
 * CLOSED (no stamp without a positive branch read). Empty `positions` = branch exists but no Phase: trailers
 * on the diff-only commits (= NOT the wedge signature — leave it alone).
 */
export async function readBranchPhaseTrailers(
  branch: string,
): Promise<{ headSha: string; positions: Set<number> } | null> {
  if (!ghToken()) return null;
  // compare(main...branch) returns ONLY commits on the branch and not on main (the same range P1 shells out to
  // via `git log origin/main..HEAD`). GitHub trims commit lists at 250; a wedge with more phases would still
  // land its trailer on the last-N commits (the finalize commit + queueNextChainedPhase's per-phase commit),
  // which fall inside the returned window.
  const r = await gh("GET", `/repos/${GH_REPO}/compare/main...${encodeURIComponent(branch)}`);
  if (!r.ok) return null;
  const body = (r.json || {}) as Record<string, unknown>;
  const commits = Array.isArray(body.commits) ? (body.commits as Array<Record<string, unknown>>) : null;
  // `body.head_commit.sha` is the branch tip; fall back to the last compare commit.
  const headSha =
    (body.head_commit as { sha?: string } | undefined)?.sha ??
    (commits && commits.length ? ((commits[commits.length - 1].sha as string | undefined) ?? null) : null);
  if (typeof headSha !== "string" || !headSha) return null;
  const positions = new Set<number>();
  for (const c of commits ?? []) {
    const message = ((c.commit as { message?: string } | undefined)?.message ?? "") as string;
    // Same regex as P1's finalize path (line-anchored, case-insensitive) — never matches a stray "Phase 2"
    // reference in a commit body; only bona-fide `Phase: N` trailers.
    const trailerRe = /^\s*Phase:\s*(\d+)\s*$/gim;
    let m: RegExpExecArray | null;
    while ((m = trailerRe.exec(message)) !== null) positions.add(parseInt(m[1], 10));
  }
  return { headSha, positions };
}

export interface DirtyPrResult {
  checked: number;
  conflicting: number;
  enqueued: number;
  /** dirty-pr-resolver-duplicate-detection: PRs closed because their work already merged via a sibling. */
  closedDuplicate: number;
  prs: Array<{ number: number; branch: string; mergeable: boolean | null; enqueued: boolean; closedDuplicate?: boolean }>;
}

/**
 * The webhook's whole job: list open `claude/*` PRs, find the newly-CONFLICTING ones, enqueue a
 * deduped pr-resolve job for each. Touches `claude/*` build branches ONLY (never a human PR). Bounded
 * and best-effort — a transient GitHub error on one PR doesn't block the others.
 */
export async function detectAndEnqueueDirtyPrs(admin?: Admin): Promise<DirtyPrResult> {
  const db = admin || createAdminClient();
  const result: DirtyPrResult = { checked: 0, conflicting: 0, enqueued: 0, closedDuplicate: 0, prs: [] };
  if (!ghToken()) return result;

  const list = await gh("GET", `/repos/${GH_REPO}/pulls?state=open&per_page=100`);
  if (!list.ok || !Array.isArray(list.json)) return result;

  // claude/* build branches only — never touch a human PR or main directly (guardrail).
  //
  // pr-resolve-supersede-action-authorization: also demand head.repo.full_name === GH_REPO. A fork
  // PR whose head ref happens to be named `claude/…` MUST NOT enter the resolve pipeline — otherwise
  // closing that PR + deleting `refs/heads/claude/…` would delete OUR internal branch, not the fork's.
  const claudePrs = (list.json as Array<Record<string, unknown>>).filter((p) => {
    const head = (p.head as { ref?: string; repo?: { full_name?: string } } | undefined);
    const ref = head?.ref || "";
    const headRepo = head?.repo?.full_name;
    return typeof ref === "string" && ref.startsWith("claude/") && headRepo === GH_REPO;
  });
  if (!claudePrs.length) return result;

  const workspaceId = await resolveBuildWorkspaceId(db);
  if (!workspaceId) return result;

  for (const p of claudePrs) {
    const prNumber = Number(p.number);
    const head = p.head as { ref?: string; sha?: string; repo?: { full_name?: string } };
    const branch = head.ref as string;
    const headSha = typeof head.sha === "string" ? head.sha : "";
    result.checked++;
    let mergeable: boolean | null;
    try {
      ({ mergeable } = await fetchMergeable(prNumber));
    } catch {
      mergeable = null;
    }
    // mergeable === false ⇒ CONFLICTING (the only state we act on). true ⇒ clean; null ⇒ unknown/still
    // computing or already merged/closed → skip (a later event re-checks).
    let enqueued = false;
    let closedDup = false;
    if (mergeable === false) {
      result.conflicting++;
      try {
        // dirty-pr-resolver-duplicate-detection (Phase 1): if this PR's work already merged via a sibling
        // build, it is unresolvable by definition (its diff is already on main → rebasing re-conflicts).
        // Close it + delete the branch with a clear comment instead of looping the resolver on it.
        const dup = headSha ? await findAlreadyMergedDuplicate(db, branch) : null;
        if (dup && headSha) {
          const sib = dup.mergedPr ? `#${dup.mergedPr}` : (dup.mergedBranch ?? "a sibling build");
          const closed = await closeDuplicatePr(
            prNumber,
            branch,
            `Closing as a duplicate: this spec (\`${dup.specSlug}\`) already shipped via ${sib}, so this PR's changes are already on \`main\`. There is nothing left to merge — rebasing would only re-conflict. Auto-closed by the dirty-PR resolver (dirty-pr-resolver-duplicate-detection).`,
            { expectedHeadSha: headSha },
          );
          if (closed.ok) {
            closedDup = true;
            result.closedDuplicate++;
            console.log(`[dirty-pr] closed duplicate PR #${prNumber} (${branch}) — ${dup.specSlug} already merged via ${sib}${closed.reason ? ` (${closed.reason})` : ""}`);
          } else {
            console.log(`[dirty-pr] refused to close duplicate PR #${prNumber} (${branch}): ${closed.reason}`);
          }
        }
        if (!closedDup) {
          const r = await enqueuePrResolveJob(db, { workspaceId, prNumber, branch });
          enqueued = r.enqueued;
          if (enqueued) result.enqueued++;
        }
      } catch {
        /* best-effort — next event retries */
      }
    }
    result.prs.push({ number: prNumber, branch, mergeable, enqueued, closedDuplicate: closedDup });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate A — auto-merge ready PRs (auto-ship-pipeline spec, Phase 1).
//
// The mirror of the dirty-PR detector above: that one acts on CONFLICTING claude/* PRs (→ pr-resolve),
// this one acts on READY ones (mergeable + all checks green) → squash-merge + delete branch, directly via
// the GitHub REST API (the same path/token the webhook already uses — no box worker, the merge is a single
// API call). It automates the owner's rubber-stamp "merge" click on green build PRs, keeping the judgment
// (supervisable autonomy): a bounded proxy (merge-when-green), an owner kill-switch, sync-aware, serialized,
// and every merge surfaced (Control Tower heartbeat + log). It NEVER force-merges a conflict (left for the
// resolver) or a red/pending PR (left for the human) — hitting a rail = leave it, never push through.
// ─────────────────────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

/** sync_jobs statuses that count as an active Inngest sync (a Vercel deploy would reap a running function). */
const SYNC_ACTIVE_STATUSES = ["pending", "running"];
/** A 'running'/'pending' sync_jobs row older than this is treated as STALE (crashed/orphaned), not active — so a
 *  stuck sync never blocks auto-merge forever. The real Shopify/Appstle syncs complete well within this window. */
const SYNC_STALE_MS = 2 * HOUR_MS;

/**
 * Kill-switch: is auto-merge enabled for the build-console workspace? Default ENABLED (true) — the spec
 * automates the owner's merge click, the flag exists to PAUSE it. Read via `select("*")` so a deploy that
 * lands before the `auto_merge_enabled` migration applies degrades gracefully (column absent ⇒ undefined ⇒
 * enabled), and a read failure also defaults to enabled (best-effort; the merge itself is still guarded by
 * mergeable+green). Only an explicit `auto_merge_enabled === false` pauses the gate.
 *
 * migrate-ad-hoc-kill-switches-to-resolver Phase 1: the legacy `workspaces.auto_merge_enabled` read is
 * wrapped by [[./control-tower/legacy-switch-compat]] `readEffectiveOnOff('pr-resolve', ...)` so a
 * `platform`-scope kill_switches row (department seat OR the `pr-resolve` agent) also pauses the gate.
 * Union semantics — either source OFF wins.
 */
export async function isAutoMergeEnabled(admin: Admin): Promise<boolean> {
  const legacyFn = async (): Promise<boolean | undefined> => {
    try {
      const workspaceId = await resolveBuildWorkspaceId(admin);
      if (!workspaceId) return true;
      const { data } = await admin.from("workspaces").select("*").eq("id", workspaceId).maybeSingle();
      const flag = (data as Record<string, unknown> | null)?.auto_merge_enabled;
      return flag !== false;
    } catch {
      return true;
    }
  };
  return isEffectivelyEnabled("pr-resolve", legacyFn);
}

/**
 * Sync-aware guard: is an Inngest sync active right now? Pushing a deploy (which a squash-merge triggers)
 * during an active Shopify/Appstle sync reaps the running function (the standing CLAUDE.md rule). True ⇒
 * defer auto-merge to the next safe window (a later webhook re-checks). Recency-guarded so a stale 'running'
 * row can't block forever; best-effort (a read failure ⇒ false ⇒ don't block on an unknown).
 */
export async function isInngestSyncActive(admin: Admin): Promise<boolean> {
  try {
    const since = new Date(Date.now() - SYNC_STALE_MS).toISOString();
    const { data } = await admin
      .from("sync_jobs")
      .select("id")
      .in("status", SYNC_ACTIVE_STATUSES)
      .gte("created_at", since)
      .limit(1);
    return !!(data && data.length);
  } catch {
    return false;
  }
}

/**
 * Poll a single PR until BOTH `mergeable` and `mergeable_state` settle (GitHub computes them lazily — null /
 * "unknown" right after a push or while checks run). Returns the settled PR object. `mergeable_state` is the
 * canonical "all green" signal: "clean" ⇒ mergeable AND every commit status / check passing AND not behind;
 * "unstable" ⇒ a non-required check is failing/pending; "blocked" ⇒ a required check failing/pending; "dirty"
 * ⇒ conflicts; "draft"/"behind" excluded. We only auto-merge on "clean".
 */
async function fetchReadyPr(
  prNumber: number,
  maxAttempts = 4,
  delayMs = 1200,
): Promise<{ mergeable: boolean | null; mergeableState: string | null; pr: Record<string, unknown> }> {
  let pr: Record<string, unknown> = {};
  for (let i = 0; i < maxAttempts; i++) {
    const r = await gh("GET", `/repos/${GH_REPO}/pulls/${prNumber}`);
    pr = (r.json || {}) as Record<string, unknown>;
    if (!r.ok) return { mergeable: null, mergeableState: null, pr };
    if (pr.state !== "open" || pr.merged) return { mergeable: null, mergeableState: null, pr };
    const m = pr.mergeable;
    const ms = pr.mergeable_state;
    if (typeof m === "boolean" && typeof ms === "string" && ms !== "unknown") {
      return { mergeable: m, mergeableState: ms, pr };
    }
    if (i < maxAttempts - 1) await sleep(delayMs);
  }
  return {
    mergeable: typeof pr.mergeable === "boolean" ? (pr.mergeable as boolean) : null,
    mergeableState: typeof pr.mergeable_state === "string" ? (pr.mergeable_state as string) : null,
    pr,
  };
}

/**
 * A PR is READY to auto-merge iff it is an open, non-draft, non-merged claude/* PR that is mergeable (no
 * conflicts) AND mergeable_state === "clean" (all checks green, not behind, no pending/blocking status).
 * Anything else — dirty (→ resolver), blocked/unstable (red/pending check → human), behind, draft, unknown —
 * is NOT ready and is left alone.
 */
function isPrReady(mergeable: boolean | null, mergeableState: string | null, pr: Record<string, unknown>): boolean {
  if (pr.state !== "open" || pr.merged || pr.draft === true) return false;
  return mergeable === true && mergeableState === "clean";
}

/** Squash-merge a PR (pinned to the evaluated head `sha` to avoid a TOCTOU race) then delete its branch (best-effort). */
async function squashMergeAndDelete(
  prNumber: number,
  branch: string,
  headSha: string | undefined,
): Promise<{ merged: boolean; mergeSha?: string | null; reason?: string }> {
  const body: Record<string, unknown> = { merge_method: "squash" };
  if (headSha) body.sha = headSha;
  const r = await gh("PUT", `/repos/${GH_REPO}/pulls/${prNumber}/merge`, body);
  if (!r.ok) {
    const msg = (r.json as Record<string, unknown>)?.message;
    return { merged: false, reason: `merge failed (${r.status}${msg ? `: ${msg}` : ""})` };
  }
  // The merge response carries the squash commit's SHA — the `last_merge_sha` the board's "deploying → live"
  // chip compares against (chain-and-cardstate-under-automerge).
  const mergeSha = (r.json as Record<string, unknown>)?.sha;
  // Delete the merged branch (mirrors the owner's "delete branch" on squash-merge). Best-effort — a 404/422
  // (already gone / protected) is fine; the merge already landed.
  try {
    await gh("DELETE", `/repos/${GH_REPO}/git/refs/heads/${branch}`);
  } catch {
    /* best-effort branch cleanup */
  }
  return { merged: true, mergeSha: typeof mergeSha === "string" ? mergeSha : null };
}

/**
 * spec-goal-branch-pm-flow M4 — the result of merging one spec branch into a goal branch.
 *  - `merged` — the spec branch's commits are now on the goal branch (`mergeSha` = the merge commit, or the
 *    goal-branch tip when nothing was new to merge — already-merged is idempotent success).
 *  - `conflict` — GitHub returned 409 (the merge has conflicts). NOT merged; surfaced so the caller escalates
 *    rather than silently dropping the spec. (Goal-branch conflicts shouldn't normally happen — specs build
 *    in blocked_by order OFF the goal branch — but a concurrent author can still produce one.)
 *  - `created` — the goal branch `goal/{goalSlug}` did not exist and was seeded from `origin/main` first.
 *  - `escalated` — parallel-build-serialized-merge-and-deadlock-autobreak Phase 3. An irreducible conflict
 *    surfaced during the pre-merge REBASE (the goal branch has advanced beneath this spec branch and merging
 *    the newer goal-branch changes INTO the spec branch conflicts). NOT merged, NOT force-merged; the caller
 *    escalates via `director_activity` and holds the promotion so a human resolves the conflict.
 *  - `rebased` — the pre-merge rebase (goal-branch → spec-branch) ran and merged cleanly; the subsequent
 *    spec→goal merge below used the rebased head. Purely informational — mostly for tests / logs.
 */
export interface GoalBranchMergeResult {
  merged: boolean;
  conflict: boolean;
  created: boolean;
  escalated: boolean;
  rebased: boolean;
  mergeSha: string | null;
  reason?: string;
}

/**
 * parallel-build-serialized-merge-and-deadlock-autobreak Phase 3 — the shape of a GitHub `compare` result
 * the rebase-decision predicate reads. Kept independent of the raw API payload so the predicate is
 * unit-testable without a fetch stub. Fields mirror `GET /repos/{owner}/{repo}/compare/{base}...{head}`:
 *  - `status` — GitHub's own classification. `identical` = head is base; `ahead` = head has commits base
 *    doesn't (fast-forwardable); `behind` = base has commits head doesn't (spec already integrated);
 *    `diverged` = both have distinct commits (needs a rebase to avoid a spurious merge / file-overlap
 *    collision when the goal branch advanced beneath this spec branch).
 *  - `aheadBy` / `behindBy` — commit counts; useful for the reason string.
 *  - `headSha` / `baseSha` — the two branch tips (informational).
 */
export interface GoalBranchCompareResult {
  status: "identical" | "ahead" | "behind" | "diverged";
  aheadBy: number;
  behindBy: number;
  headSha: string | null;
  baseSha: string | null;
}

/**
 * parallel-build-serialized-merge-and-deadlock-autobreak Phase 3 — the decision the merge helper reads.
 *  - `merge` — spec branch is `ahead` (or `identical`-behind-idempotent path) of goal branch; direct merge
 *    is safe (no goal-branch drift to reconcile).
 *  - `rebase-then-merge` — spec branch has DIVERGED from goal branch (a sibling merged something new since
 *    this spec branched off); pull the goal branch's advances INTO the spec branch first, THEN merge. This
 *    is the guard that stops Phase-2's parallel builds from producing a #1893-style file-overlap collision
 *    at merge time — even when two specs pass blocked_by independence, if they touch one file, one must
 *    rebase on top of the other before landing.
 *  - `skip` — no-op path (identical / already-integrated). Idempotent success upstream.
 *  - `escalate` — the prior rebase attempt itself hit an irreducible conflict, OR the attempt budget is
 *    exhausted. Never force-merge; the caller writes `director_activity` + holds the promotion.
 */
export type GoalBranchRebaseDecision =
  | { action: "merge"; reason: string }
  | { action: "rebase-then-merge"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "escalate"; reason: string };

/** How many rebase attempts we make before escalating an irreducible conflict. One retry is enough to
 *  catch a "goal branch advanced during the compare→merge window" race; a second means the conflict is
 *  real. Kept module-level so the predicate + async wrapper + tests share the constant. */
export const GOAL_BRANCH_REBASE_MAX_ATTEMPTS = 2;

/** PURE predicate — given the compare result + the number of PRIOR rebase attempts, decide the next action.
 *  Kept pure so the named failing state — "two goal-mate branches touching the same file merge cleanly via
 *  serialized rebase; an irreducible conflict escalates rather than force-merging" — is unit-testable
 *  without a GitHub stub. Fail-safe on missing `status` (defaults to `escalate`) so a malformed compare
 *  payload never accidentally authorizes a direct merge. */
export function decideGoalBranchRebaseMerge(input: {
  compare: GoalBranchCompareResult;
  priorRebaseAttempts?: number;
  maxAttempts?: number;
}): GoalBranchRebaseDecision {
  const { compare, priorRebaseAttempts = 0, maxAttempts = GOAL_BRANCH_REBASE_MAX_ATTEMPTS } = input;
  if (!compare || !compare.status) {
    return { action: "escalate", reason: "compare payload missing status — fail closed" };
  }
  if (compare.status === "identical") {
    return { action: "skip", reason: "identical: spec branch head equals goal branch head — nothing to merge" };
  }
  if (compare.status === "behind") {
    return { action: "skip", reason: `spec branch is behind goal branch by ${compare.behindBy} — already integrated (no-op)` };
  }
  if (compare.status === "ahead") {
    return { action: "merge", reason: `ahead by ${compare.aheadBy} — fast-forwardable, direct merge is safe` };
  }
  // diverged — a sibling has advanced the goal branch beneath us; rebase first (bring the goal-branch's
  // advances INTO the spec branch) so the subsequent spec→goal merge is a clean fast-forward against the
  // now-current base. Two goal-mate branches touching one file are the exact scenario this guards.
  if (priorRebaseAttempts >= maxAttempts) {
    return {
      action: "escalate",
      reason: `irreducible conflict: attempted ${priorRebaseAttempts} rebase(s), goal branch still diverged (ahead=${compare.aheadBy}, behind=${compare.behindBy}) — escalating rather than force-merging`,
    };
  }
  return {
    action: "rebase-then-merge",
    reason: `diverged (ahead=${compare.aheadBy}, behind=${compare.behindBy}) — merging goal branch into spec branch to bring in the sibling's advances, then the spec→goal merge is a clean fast-forward`,
  };
}

/** Read `compare(base=goal, head=spec)` via the GitHub API and normalize into a
 *  `GoalBranchCompareResult`. Returns `null` on any failure so the caller fails CLOSED (no rebase-decision
 *  authorized without a positive read). */
export async function compareGoalBranchToSpecBranch(
  goalBranch: string,
  specBranch: string,
): Promise<GoalBranchCompareResult | null> {
  if (!ghToken()) return null;
  const r = await gh(
    "GET",
    `/repos/${GH_REPO}/compare/${encodeURIComponent(goalBranch)}...${encodeURIComponent(specBranch)}`,
  );
  if (!r.ok) return null;
  const body = (r.json || {}) as Record<string, unknown>;
  const statusRaw = (body.status as string) || "";
  const status =
    statusRaw === "identical" || statusRaw === "ahead" || statusRaw === "behind" || statusRaw === "diverged"
      ? statusRaw
      : null;
  if (!status) return null;
  const aheadBy = typeof body.ahead_by === "number" ? (body.ahead_by as number) : 0;
  const behindBy = typeof body.behind_by === "number" ? (body.behind_by as number) : 0;
  const baseSha = ((body.base_commit as { sha?: string } | undefined)?.sha ?? null) as string | null;
  const headSha = ((body.head_commit as { sha?: string } | undefined)?.sha ?? null) as string | null;
  return { status, aheadBy, behindBy, baseSha, headSha };
}

// parallel-build-serialized-merge-and-deadlock-autobreak Phase 3 — per-goal in-process serialization
// mutex for `mergeSpecBranchIntoGoalBranch`. The M4 loop in `promoteEligibleSpecsToGoalBranch` is
// already sequential within one invocation; this mutex is the belt against RE-ENTRANT invocations
// (the standing pass and a github webhook both firing at overlapping times). We chain each new merge
// onto the prior completion promise per-goal, so two concurrent calls for the same goal queue rather
// than race the GitHub `POST /merges` endpoint. Cross-goal invocations are independent.
const goalBranchMergeSerializer = new Map<string, Promise<unknown>>();
async function withGoalBranchMergeLock<T>(goalBranch: string, body: () => Promise<T>): Promise<T> {
  const prior = goalBranchMergeSerializer.get(goalBranch) ?? Promise.resolve();
  const next = prior.then(body, body);
  // Store the "in-progress" promise so the NEXT caller chains after it; on completion, only clear the
  // slot if we're still the current tail (a still-newer caller may have already chained after us).
  const stored: Promise<unknown> = next.finally(() => {
    if (goalBranchMergeSerializer.get(goalBranch) === stored) {
      goalBranchMergeSerializer.delete(goalBranch);
    }
  });
  goalBranchMergeSerializer.set(goalBranch, stored);
  return next;
}

/** Test-only accessor — for the pure serialization test to observe the in-flight promise per goal.
 *  Not intended for production callers; the mutex is transparent above the caller. */
export function _peekGoalBranchMergeSerializer(goalBranch: string): Promise<unknown> | undefined {
  return goalBranchMergeSerializer.get(goalBranch);
}

/** Test-only accessor — directly drive the per-goal serialization mutex used by
 *  `mergeSpecBranchIntoGoalBranch`. Kept exported ONLY so the pure Phase-3 unit test can pin the
 *  serialization contract (two concurrent bodies for the SAME goal-branch run strictly one-at-a-time)
 *  without needing a live GitHub. Production callers MUST use `mergeSpecBranchIntoGoalBranch` — this
 *  helper does no argument validation and no network work. */
export function _withGoalBranchMergeLockForTests<T>(goalBranch: string, body: () => Promise<T>): Promise<T> {
  return withGoalBranchMergeLock(goalBranch, body);
}

/** Resolve a branch ref's tip SHA (`refs/heads/{branch}`). Null if the ref doesn't exist. */
async function branchHeadSha(branch: string): Promise<string | null> {
  const r = await gh("GET", `/repos/${GH_REPO}/git/ref/heads/${branch}`);
  if (!r.ok) return null;
  const obj = (r.json as Record<string, unknown>)?.object as { sha?: string } | undefined;
  return typeof obj?.sha === "string" ? obj.sha : null;
}

/**
 * spec-goal-branch-pm-flow M4 — merge a spec's `claude/build-{slug}` branch INTO its goal branch
 * `goal/{goalSlug}`, creating the goal branch from `origin/main` if it doesn't exist yet (the FIRST spec of a
 * goal seeds it). A real (non-squash) merge commit so the goal branch carries each spec's full history, ready
 * for M5's atomic goal→main promotion.
 *
 * Uses the GitHub API only (POST /merges, POST /git/refs) — no local checkout — so it runs identically from
 * the box worker standing pass AND the Vercel github webhook, mirroring `autoMergeReadyPrs`'s API-driven
 * style. Idempotent: a 204 (nothing to merge — head already in base) is `merged:true` with the goal-branch
 * tip as `mergeSha`. A 409 is surfaced as `conflict:true` (NOT dropped) so the caller escalates. The caller
 * stamps `specs.goal_branch_sha = mergeSha` on success (the M5 seam).
 */
export async function mergeSpecBranchIntoGoalBranch(
  specBranch: string,
  goalSlug: string,
): Promise<GoalBranchMergeResult> {
  const out: GoalBranchMergeResult = {
    merged: false,
    conflict: false,
    created: false,
    escalated: false,
    rebased: false,
    mergeSha: null,
  };
  if (!ghToken()) return { ...out, reason: "no GitHub token" };
  const goalBranch = `goal/${goalSlug}`;
  // parallel-build-serialized-merge-and-deadlock-autobreak Phase 3 — SERIALIZED, ONE AT A TIME per goal
  // (in-process mutex). Two concurrent invocations for the same goal (standing pass + webhook) queue
  // behind each other so the compare → rebase → merge sequence is never interleaved with itself. Different
  // goals proceed in parallel — the mutex is per-goal-branch.
  return withGoalBranchMergeLock(goalBranch, async () => {

  // Seed the goal branch from origin/main if it doesn't exist yet (first spec of the goal).
  let goalHead = await branchHeadSha(goalBranch);
  if (goalHead === null) {
    const mainHead = await branchHeadSha("main");
    if (!mainHead) return { ...out, reason: "could not resolve origin/main HEAD to seed the goal branch" };
    const create = await gh("POST", `/repos/${GH_REPO}/git/refs`, {
      ref: `refs/heads/${goalBranch}`,
      sha: mainHead,
    });
    if (!create.ok) {
      // 422 = ref already exists (a concurrent seed won the race) → re-read its head and continue.
      goalHead = await branchHeadSha(goalBranch);
      if (goalHead === null) {
        const msg = (create.json as Record<string, unknown>)?.message;
        return { ...out, reason: `seed ${goalBranch} from main failed (${create.status}${msg ? `: ${msg}` : ""})` };
      }
    } else {
      out.created = true;
      goalHead = mainHead;
    }
  }

  // parallel-build-serialized-merge-and-deadlock-autobreak Phase 3 — REBASE-BEFORE-MERGE. If the goal
  // branch has advanced beneath this spec branch (another goal-mate merged since this branch forked),
  // the straight `POST /merges spec→goal` risks a file-overlap collision (two independent-by-DAG specs
  // touching one file). Compare first; on `diverged` do the rebase (merge goal INTO spec) before the
  // spec→goal merge. Up to `GOAL_BRANCH_REBASE_MAX_ATTEMPTS` attempts; an irreducible conflict escalates
  // via `escalated:true` — the caller writes a `director_activity` row + HOLDS the promotion instead of
  // force-merging.
  for (let attempt = 0; attempt < GOAL_BRANCH_REBASE_MAX_ATTEMPTS; attempt++) {
    const cmp = await compareGoalBranchToSpecBranch(goalBranch, specBranch);
    if (!cmp) break; // compare failed — fall through to the original merge (fail-safe: the merge itself will 409 on real conflict)
    const decision = decideGoalBranchRebaseMerge({ compare: cmp, priorRebaseAttempts: attempt });
    if (decision.action === "merge") break; // proceed to the spec→goal merge below
    if (decision.action === "skip") {
      out.merged = true;
      out.mergeSha = cmp.baseSha ?? goalHead;
      out.reason = decision.reason;
      return out;
    }
    if (decision.action === "escalate") {
      out.escalated = true;
      out.reason = decision.reason;
      return out;
    }
    // rebase-then-merge — pull the goal branch's advances INTO the spec branch first.
    const rebase = await gh("POST", `/repos/${GH_REPO}/merges`, {
      base: specBranch,
      head: goalBranch,
      commit_message: `goal-branch rebase: merge ${goalBranch} into ${specBranch} (parallel-build-serialized-merge Phase 3, attempt ${attempt + 1})`,
    });
    if (rebase.status === 201 || rebase.status === 204) {
      out.rebased = true;
      continue; // loop → re-compare; on the next iteration `ahead` / `identical` should hold
    }
    if (rebase.status === 409) {
      // The rebase itself conflicts — the two branches genuinely touched the same lines. Escalate; a
      // human resolves via the existing pr-resolve flow. NEVER force-merge.
      out.escalated = true;
      out.reason = `irreducible rebase conflict (409) on ${goalBranch}→${specBranch} — parallel goal-mates touched the same file. Escalated; NOT force-merged.`;
      return out;
    }
    // Any other rebase failure — treat as escalate rather than blindly falling through to merge.
    const rmsg = (rebase.json as Record<string, unknown>)?.message;
    out.escalated = true;
    out.reason = `rebase ${goalBranch}→${specBranch} failed (${rebase.status}${rmsg ? `: ${rmsg}` : ""}) — escalated`;
    return out;
  }

  // Merge the spec branch into the goal branch (real merge commit).
  const r = await gh("POST", `/repos/${GH_REPO}/merges`, {
    base: goalBranch,
    head: specBranch,
    commit_message: `goal-branch integration: merge ${specBranch} into ${goalBranch} (spec-goal-branch-pm-flow M4)`,
  });
  if (r.status === 201) {
    const sha = (r.json as Record<string, unknown>)?.sha;
    out.merged = true;
    out.mergeSha = typeof sha === "string" ? sha : null;
    return out;
  }
  if (r.status === 204) {
    // Nothing to merge — head already contained in base (already integrated). Idempotent success; the
    // goal-branch tip is the effective integration SHA.
    out.merged = true;
    out.mergeSha = goalHead;
    out.reason = "already integrated (nothing to merge)";
    return out;
  }
  if (r.status === 409) {
    out.conflict = true;
    out.reason = "merge conflict (409) — left for the owner; NOT dropped";
    return out;
  }
  const msg = (r.json as Record<string, unknown>)?.message;
  return { ...out, reason: `merge ${specBranch} → ${goalBranch} failed (${r.status}${msg ? `: ${msg}` : ""})` };
  });
}

/**
 * spec-goal-branch-pm-flow M5 — the result of the atomic goal→main merge.
 *  - `merged` — `goal/{goalSlug}`'s commits are now on `main` in ONE merge (`mergeSha` = the merge commit, or
 *    the main tip when nothing was new to merge — already-merged is idempotent success).
 *  - `conflict` — GitHub returned 409 (the goal branch conflicts with main). NOT merged; surfaced so the caller
 *    HOLDS the promotion (does NOT stamp shipped) and leaves it for the owner / a resolver.
 *  - `missingBranch` — `goal/{goalSlug}` does not exist (nothing to promote — e.g. a parent goal, or a goal
 *    whose specs never reached the goal branch). NOT a failure; the caller skips it.
 */
export interface GoalToMainMergeResult {
  merged: boolean;
  conflict: boolean;
  missingBranch: boolean;
  mergeSha: string | null;
  reason?: string;
}

/**
 * spec-goal-branch-pm-flow M5 — merge a goal's `goal/{goalSlug}` branch INTO `main`, ATOMICALLY (one merge
 * commit carrying every member spec's integrated history). Mirrors `mergeSpecBranchIntoGoalBranch`'s
 * API-only style (POST /merges, no local checkout) so it runs identically from the box worker standing pass
 * AND the Vercel github webhook.
 *
 * GREEN signal (the spec's option b — combination-verified WITHOUT extra preview deploys): the CALLER
 * (`promoteCompleteGoalsToMain`) only invokes this once (1) every member spec is individually
 * `isSpecPromoteEligible` (accumulation + spec-test-green + security-green on its branch) AND (2) every member
 * spec is ON the goal branch (`goalBranchState.allOnGoalBranch`) — and because each dependent spec BUILDS off
 * the goal branch (M4 ordering), the integrated WHOLE was compiled together by the worker's per-build tsc
 * gate. This merge is then the final combination check: it is ATOMIC — a 201/204 means the integrated goal
 * branch merges cleanly onto main (no main drift); a 409 means a conflict with main → the promotion is HELD
 * (nothing is stamped shipped), never force-pushed. So the COMBINATION (not just the parts) is verified: the
 * parts on their branches + the integrated whole on the goal branch + a clean atomic land on main.
 *
 * Idempotent: a 204 (nothing to merge — goal branch already contained in main) is `merged:true` with the main
 * tip as `mergeSha`. A missing goal branch is `missingBranch:true` (skip, not fail). Uses a real (non-squash)
 * merge commit so main carries the goal's full per-spec history. Deletes the goal branch on success
 * (best-effort) — the goal is shipped, the branch is spent.
 */
export async function mergeGoalBranchIntoMain(goalSlug: string): Promise<GoalToMainMergeResult> {
  const out: GoalToMainMergeResult = { merged: false, conflict: false, missingBranch: false, mergeSha: null };
  if (!ghToken()) return { ...out, reason: "no GitHub token" };
  const goalBranch = `goal/${goalSlug}`;

  const goalHead = await branchHeadSha(goalBranch);
  if (goalHead === null) {
    return { ...out, missingBranch: true, reason: `goal branch ${goalBranch} does not exist — nothing to promote` };
  }

  const r = await gh("POST", `/repos/${GH_REPO}/merges`, {
    base: "main",
    head: goalBranch,
    commit_message: `atomic goal promotion: merge ${goalBranch} into main (spec-goal-branch-pm-flow M5)`,
  });
  if (r.status === 201) {
    const sha = (r.json as Record<string, unknown>)?.sha;
    out.merged = true;
    out.mergeSha = typeof sha === "string" ? sha : null;
    // Goal shipped — delete the spent goal branch (best-effort; a 404/422 is fine).
    try {
      await gh("DELETE", `/repos/${GH_REPO}/git/refs/heads/${goalBranch}`);
    } catch {
      /* best-effort branch cleanup */
    }
    return out;
  }
  if (r.status === 204) {
    // Already on main (goal branch fully contained) — idempotent success; main tip is the effective SHA.
    out.merged = true;
    out.mergeSha = await branchHeadSha("main");
    out.reason = "already integrated (nothing to merge)";
    try {
      await gh("DELETE", `/repos/${GH_REPO}/git/refs/heads/${goalBranch}`);
    } catch {
      /* best-effort */
    }
    return out;
  }
  if (r.status === 409) {
    out.conflict = true;
    out.reason = "goal→main merge conflict (409) — promotion HELD, NOT stamped shipped; left for the owner";
    return out;
  }
  const msg = (r.json as Record<string, unknown>)?.message;
  return { ...out, reason: `merge ${goalBranch} → main failed (${r.status}${msg ? `: ${msg}` : ""})` };
}

export interface AutoMergeResult {
  enabled: boolean;
  syncActive: boolean;
  checked: number;
  ready: number;
  /** optimizer-launch-hardening Phase 2: PRs that were GitHub-clean but whose owning build job had NOT
   * succeeded (or no job owned the branch) — refused by the success gate, left for the owner. */
  buildGateBlocked: number;
  /** promote-on-green-merge-gate Phase 1: PRs that passed mergeable+clean+build-gate but whose pre-merge
   *  spec-test green AND security green signals weren't BOTH true for the branch — left `in_testing` for
   *  the next pass (the per-branch signals settle as the box completes the M2 pre-merge runs). */
  testsGateBlocked: number;
  /** spec-goal-branch-pm-flow M2: PRs for a MULTI-PHASE spec branch that is only PARTIALLY accumulated — a
   *  phase is still `planned` (not yet built on the branch). Promoting now would ship a partial spec to main
   *  and stamp only some phases. Deferred until every phase is built on the branch (build_sha recorded /
   *  shipped). M5 owns the actual atomic promotion; this guard just keeps the existing auto-merge from
   *  promoting a half-accumulated branch. */
  accumulationBlocked: number;
  /** spec-goal-branch-pm-flow M4/M5: PRs for a GOAL-BOUND spec — NOT merged to main by Gate A (a goal-bound
   *  spec promotes spec→goal branch via Gate B and the whole goal lands on main atomically via Gate C). Gate A
   *  merges ONE-OFF specs only; a goal-bound branch is handed off, never jumped to main here. */
  goalBoundBlocked: number;
  /** fold-pr-auto-merge: claude/fold-* PRs that were mergeable+clean but whose OWNING fold job (kind='fold',
   *  same spec_branch) was NOT yet completed/merged — refused by the fold gate, left for the next pass. A
   *  fold is a brain-doc merge of ALREADY-shipped specs, so the build/accumulation/tests/goal gates do NOT
   *  apply; the only gate is "the fold job that authored this branch finished". */
  foldGateBlocked: number;
  /** 0 or 1 — SERIALIZED: at most one merge per pass (the resulting push-to-main webhook handles the next). */
  merged: number;
  mergedPr?: number;
  prs: Array<{
    number: number;
    branch: string;
    mergeableState: string | null;
    ready: boolean;
    buildGateOk?: boolean;
    /** True when BOTH `spec-test green` AND `security green` signals are clean for the branch (M4
     *  promote-on-green Phase 1). Undefined when the build-gate refused first / the PR wasn't ready. */
    testsGateOk?: boolean;
    merged: boolean;
  }>;
}

/**
 * Gate A: list open claude/* PRs, find the READY ones, squash-merge ONE (serialized) + delete its branch.
 *
 * Guardrails (supervisable autonomy):
 *  - kill-switch: no-op when `auto_merge_enabled === false` on the build-console workspace.
 *  - sync-aware: no-op while an Inngest sync is active (a deploy would reap it) — deferred to a later webhook.
 *  - claude/* build branches ONLY — never a human PR, never a non-build branch.
 *  - SERIALIZED: merges at most ONE PR per pass so we never fan out N merges → N simultaneous Vercel deploys.
 *    The squash-merge fires a push-to-main webhook, which re-enters this gate to merge the next ready PR.
 *  - mergeable + state==="clean" only — a conflict is left for the resolver, a red/pending check for the human.
 *  - SUCCESS GATE (optimizer-launch-hardening Phase 2): because the repo has no CI / branch protection,
 *    GitHub's `clean` is vacuous — so a GitHub-clean PR is merged ONLY if its OWN build job succeeded
 *    (the branch-owning agent_job is `completed`/`merged`, i.e. the worker's pre-push tsc passed). A
 *    clean-but-not-successfully-built PR (partial/errored/paused/parked build, or an untracked manual
 *    push) is left for the owner — a gate-blocked PR never blocks a legitimately-built later PR (the
 *    serialize guard keeps scanning until one actually merges).
 *  - TESTS GATE (promote-on-green-merge-gate Phase 1, M4): on top of the build-gate, require BOTH
 *    pre-merge signals green for the branch — `isSpecTestGreenForBranch` (the M2 spec-test agent's
 *    machine pass against the per-build preview, mirrored to the post-ship fold gate's Rail 2 so the
 *    two can never disagree) AND `isSecurityGreenForBranch` (the M2 security-review's `completedClean`,
 *    mirrored to the fold gate's security rail). A clean+built PR whose pre-merge tests aren't both
 *    green is NOT promoted — it's left for the next pass, and the [[brain-roadmap]] `applyInTestingOverlay`
 *    derives its card status as `in_testing` from the SAME signals so the gate and the board never disagree.
 *    Fails CLOSED: a missing per-branch run or a read error reads as not-green ⇒ defer (absence ≠ clean).
 * Surfaces the pass as a Control Tower heartbeat (loop_id = AUTO_MERGE_GATE_LOOP_ID) + a console log.
 *
 * Reva is preserved post-promote: [[openDeployWatch]] still fires on every promote-merge (defense-in-depth
 * — a regression real traffic exposes that the pre-merge tests missed is still caught + rolled back).
 *
 * The M2 accumulation gate (`isSpecAccumulationComplete`) now lives in [[specs-table]] (M3 promoted it to
 * the SDK so the M3 pre-merge-test trigger + [[../libraries/agent-jobs]] `isSpecPromoteEligible` share the
 * SAME predicate as this gate). Imported above; called inline below.
 */

export async function autoMergeReadyPrs(admin?: Admin): Promise<AutoMergeResult> {
  const db = admin || createAdminClient();
  const result: AutoMergeResult = { enabled: true, syncActive: false, checked: 0, ready: 0, buildGateBlocked: 0, testsGateBlocked: 0, accumulationBlocked: 0, goalBoundBlocked: 0, foldGateBlocked: 0, merged: 0, prs: [] };
  let ok = true;
  try {
    if (!ghToken()) return result;

    result.enabled = await isAutoMergeEnabled(db);
    if (!result.enabled) return result;

    result.syncActive = await isInngestSyncActive(db);
    if (result.syncActive) return result;

    const list = await gh("GET", `/repos/${GH_REPO}/pulls?state=open&per_page=100`);
    if (!list.ok || !Array.isArray(list.json)) return result;

    // claude/* build branches only — never touch a human PR or main directly (guardrail).
    const claudePrs = (list.json as Array<Record<string, unknown>>).filter((p) => {
      const ref = (p.head as { ref?: string } | undefined)?.ref || "";
      return typeof ref === "string" && ref.startsWith("claude/");
    });

    for (const p of claudePrs) {
      const prNumber = Number(p.number);
      const branch = (p.head as { ref?: string }).ref as string;
      result.checked++;
      let mergeable: boolean | null = null;
      let mergeableState: string | null = null;
      let pr: Record<string, unknown> = p;
      try {
        ({ mergeable, mergeableState, pr } = await fetchReadyPr(prNumber));
      } catch {
        mergeable = null;
        mergeableState = null;
      }
      const ready = isPrReady(mergeable, mergeableState, pr);
      let merged = false;
      let buildGateOk: boolean | undefined;
      let testsGateOk: boolean | undefined;
      if (ready) {
        result.ready++;
        // SERIALIZE: only attempt the first ready PR — the post-merge push webhook drives the next one.
        // (A gate-blocked PR leaves result.merged at 0, so the scan continues to the next ready PR.)
        if (result.merged === 0) {
          // sub-task 1b — hoisted to this (merge) scope so the post-merge advisory below can read them: the
          // promoting spec's (workspace, slug) + whether its clean pre-merge run had ZERO machine coverage
          // (auto_pass=0, a human-only Verification). Set inside the build-gate branch; a fold PR leaves them
          // null/false (the advisory is build-branch only).
          let promoteWsId: string | null = null;
          let promoteSlug: string | null = null;
          let zeroMachineCoverage = false;
          // fold-pr-auto-merge — FOLD GATE (the build gates DO NOT apply to a fold PR): a claude/fold-* OR
          // claude/goal-fold-* PR is a brain-doc merge of ALREADY-shipped work the SYSTEM authored — runFoldJob
          // batches every owner-verified spec into ONE `claude/fold-…` branch; runGoalFoldJob folds ONE complete
          // goal into `claude/goal-fold-…`. There is no spec accumulation to wait on, no pre-merge spec-test/
          // security to run, and no goal-bound promotion — those gates are all about a NOT-yet-shipped feature
          // build reaching main. So a (goal-)fold PR is promoted on a SINGLE condition: mergeable+clean (the
          // isPrReady above) AND its OWNING fold/goal-fold job (same spec_branch) is in a completed/succeeded
          // status. The branch → owning-job match is the `spec_branch` column (the worker stamps it = the
          // claude/(goal-)fold-… ref), and getBranchBuildSuccess resolves the latest BRANCH_OWNING_KINDS job —
          // which now includes BOTH 'fold' and 'goal-fold' — for that ref. A branch owned by NOTHING (a manual/
          // untracked push, no agent_jobs row) still reads `ok:false` here and is left for the owner — only a
          // COMPLETED system fold/goal-fold job clears this gate. We then fall through to the SAME shared merge
          // path the build PRs use. Still SERIALIZED: this sits inside `result.merged === 0`, so a (goal-)fold
          // merge counts as the one merge for the pass and the post-merge push webhook drives the next.
          if (branch.startsWith("claude/fold-") || branch.startsWith("claude/goal-fold-")) {
            const foldGate = await getBranchBuildSuccess(branch, db);
            buildGateOk = foldGate.ok;
            if (!foldGate.ok) {
              result.foldGateBlocked++;
              console.warn(`[auto-merge] fold PR #${prNumber} (${branch}) is GitHub-clean but its owning fold/goal-fold job hasn't completed: ${foldGate.reason} — left for the next pass`);
              result.prs.push({ number: prNumber, branch, mergeableState, ready, buildGateOk, merged });
              continue;
            }
            // Fold gate passed → fall through to the shared squash-merge action below (skips ALL build gates).
          } else {
          // optimizer-launch-hardening Phase 2 — success gate: GitHub's "clean" is vacuous here (no CI /
          // branch protection), so additionally require the branch's OWN build job to have succeeded
          // (completed/merged ⇒ the worker's pre-push tsc passed). Refuse a clean-but-unbuilt PR.
          const gate = await getBranchBuildSuccess(branch, db);
          buildGateOk = gate.ok;
          if (!gate.ok) {
            result.buildGateBlocked++;
            console.warn(`[auto-merge] PR #${prNumber} (${branch}) is GitHub-clean but the build success gate refused it: ${gate.reason} — left for the owner`);
            result.prs.push({ number: prNumber, branch, mergeableState, ready, buildGateOk, merged });
            continue;
          }
          const wsId = gate.workspaceId;
          const slug = gate.specSlug;
          promoteWsId = wsId;
          promoteSlug = slug;
          // spec-goal-branch-pm-flow M4/M5 — GOAL-BOUND GUARD: Gate A merges a spec branch straight to `main`,
          // which is correct ONLY for a ONE-OFF spec (no goal). A GOAL-BOUND spec must NEVER reach main via
          // Gate A: it promotes spec-branch → its `goal/{slug}` branch (M4, `promoteEligibleSpecsToGoalBranch`)
          // and the WHOLE goal lands on main atomically (M5, `promoteCompleteGoalsToMain` → the only shipped-
          // writer for goal-bound specs, `applyGoalPromotionEffects`). If Gate A jumped it to main here it would
          // (a) ship a goal-bound spec OUTSIDE the atomic goal promotion, and (b) double-stamp — the per-build
          // `applyMergedBuildEffects` would flip its phases shipped, then M5's `applyGoalPromotionEffects` would
          // try to ship the goal's phases again. So: a spec that `resolveGoalSlugForSpec` resolves to a goal is
          // HANDED OFF to Gate B/C (skipped here). Fail OPEN — a resolve error reads as one-off (the accumulation
          // + tests gates below still protect any actual main merge). Sits BEFORE the accumulation/tests gates
          // (cheap PM read; no point evaluating those for a branch Gate A won't merge anyway).
          if (wsId && slug) {
            let goalSlug: string | null = null;
            try {
              const { resolveGoalSlugForSpec } = await import("@/lib/agent-jobs");
              goalSlug = await resolveGoalSlugForSpec(wsId, slug);
            } catch (e) {
              goalSlug = null; // fail open — treat as one-off (the gates below still guard the merge)
              console.warn(`[auto-merge] PR #${prNumber} (${branch}) goal-bound check threw — treating as one-off:`, e instanceof Error ? e.message : e);
            }
            if (goalSlug) {
              result.goalBoundBlocked++;
              console.warn(`[auto-merge] PR #${prNumber} (${branch}) is goal-bound (goal/${goalSlug}) — NOT merging to main; handed off to Gate B (spec→goal) + Gate C (atomic goal→main)`);
              result.prs.push({ number: prNumber, branch, mergeableState, ready, buildGateOk, merged });
              continue;
            }
          }
          // spec-goal-branch-pm-flow M2 — ACCUMULATION GATE: under M1's branch-accumulation model the spec's
          // phases build one-by-one onto this single PR; promoting it now (after only some phases are built)
          // would ship a PARTIAL spec to main. Refuse until EVERY phase is built on the branch (build_sha set
          // or terminal) — i.e. no phase is still `planned`. A one-shot/single-phase spec passes trivially.
          // M5 owns the eventual atomic promotion + the build_sha→shipped flip; this only stops the existing
          // auto-merge from jumping a half-accumulated branch. Sits BEFORE the tests gate (cheap PM read; no
          // point evaluating per-branch test green for a branch that isn't even fully built yet).
          const accumulation = await isSpecAccumulationComplete(wsId, slug);
          if (!accumulation.complete) {
            result.accumulationBlocked++;
            console.warn(`[auto-merge] PR #${prNumber} (${branch}) is built+clean but the spec is not fully accumulated on the branch (${accumulation.reason}) — deferring promotion (M5 promotes the whole spec)`);
            result.prs.push({ number: prNumber, branch, mergeableState, ready, buildGateOk, merged });
            continue;
          }
          // promote-on-green-merge-gate Phase 1 (M4) — TESTS GATE: require BOTH pre-merge signals green
          // for the branch. spec-test green mirrors the post-ship fold gate's Rail 2 (approved/needs_human
          // + auto_pass>=1 + 0 unresolved auto-`fail`); security green mirrors `completedClean` (a
          // `completed` security-review job with no live/surfaced sibling). The board derives `in_testing`
          // from the SAME signals (applyInTestingOverlay) so the gate and the board can never disagree.
          // Absence ≠ clean — a branch with no pre-merge run yet is NOT green ⇒ defer. The build job's
          // workspace_id + spec_slug come from the SAME row the build gate just read (no extra query).
          let specGreen = false;
          let secGreen = false;
          // sub-task 1b: did this branch's clean pre-merge run have ZERO machine coverage (auto_pass=0 —
          // its Verification is entirely advisory `needs_human` checks)? If it promotes, surface a NON-
          // BLOCKING advisory to Ada AFTER the merge so she can eyeball the human checks. Read off the SAME
          // state we gate on (no extra query); only meaningful when `specGreen` is true. (`zeroMachineCoverage`
          // is hoisted to the merge scope above.)
          try {
            if (wsId && slug) {
              const specTestState = await getSpecTestStateForBranch(wsId, slug, branch);
              specGreen = specTestState.cleanMachinePass;
              zeroMachineCoverage = (specTestState.latest?.summary.auto_pass ?? 0) === 0;
            }
            secGreen = await isSecurityGreenForBranch(db, branch);
          } catch (e) {
            // Fail CLOSED on a read error — never auto-merge past a tests gate we couldn't evaluate.
            console.warn(`[auto-merge] PR #${prNumber} (${branch}) tests-gate evaluation threw — treating as not-green:`, e instanceof Error ? e.message : e);
            specGreen = false;
            secGreen = false;
          }
          testsGateOk = specGreen && secGreen;
          if (!testsGateOk) {
            result.testsGateBlocked++;
            console.warn(
              `[auto-merge] PR #${prNumber} (${branch}) is built but pre-merge tests not BOTH green ` +
                `(spec-test=${specGreen ? "green" : "pending/red"}, security=${secGreen ? "green" : "pending/red"}) — left in_testing`,
            );
            result.prs.push({ number: prNumber, branch, mergeableState, ready, buildGateOk, testsGateOk, merged });
            continue;
          }
          } // end build-gate branch (a fold PR skips straight here once its fold gate passed)
          const headSha = (pr.head as { sha?: string } | undefined)?.sha;
          try {
            const m = await squashMergeAndDelete(prNumber, branch, headSha);
            if (m.merged) {
              merged = true;
              result.merged = 1;
              result.mergedPr = prNumber;
              console.log(`[auto-merge] squash-merged PR #${prNumber} (${branch}) + deleted branch`);
              // chain-and-cardstate-under-automerge Phase 1: the merge happened HERE (server-side), so advance
              // the build's post-merge state from this path — flip its job `merged`, roll up the card status,
              // and queue the next ⏳ phase of a "Build all" chain — without waiting for a board-render
              // reconcile. Idempotent + best-effort (it never throws); reconcileMergedJobs is the backstop.
              try {
                const advanced = await handleAutoMergedBuildBranch(branch, m.mergeSha ?? null);
                if (advanced) console.log(`[auto-merge] advanced post-merge state for ${advanced} (PR #${prNumber})`);
              } catch (e) {
                console.warn(`[auto-merge] post-merge advance for PR #${prNumber} failed:`, e instanceof Error ? e.message : e);
              }
              // deploy-health-rollback-guardian Phase 1: this squash-merge triggers a Vercel deploy, so open
              // a deploy-watch over the canary window (Reva). It snapshots the pre-deploy error/loop baseline
              // now; the deploy-guardian-cron evaluates the verdict once the window elapses. Best-effort + never
              // throws — a watch that crashes the merge it guards is worse than the gap.
              try {
                await openDeployWatch({ admin: db, branch, prNumber, mergeSha: m.mergeSha ?? null });
              } catch (e) {
                console.warn(`[auto-merge] deploy-watch open for PR #${prNumber} failed:`, e instanceof Error ? e.message : e);
              }
              // spec-test-human-only-promote-gate sub-task 1b (CEO: "ideally Ada looks at it"): this spec just
              // promoted to main, and its clean pre-merge run had ZERO machine coverage (auto_pass=0 — a
              // human-only Verification). Human checks are FULLY ADVISORY so this NEVER gated the merge above,
              // but surface a LIGHTWEIGHT, NON-BLOCKING advisory so Ada can eyeball the human checks. Idempotent
              // (one row per spec) + best-effort (never throws — an advisory that crashes the merge it follows
              // is worse than the gap).
              if (zeroMachineCoverage && promoteWsId && promoteSlug) {
                try {
                  const { recorded } = await recordHumanOnlyPromoteAdvisory(db, promoteWsId, promoteSlug);
                  if (recorded) console.log(`[auto-merge] surfaced human-only-promote advisory for ${promoteSlug} (no machine coverage)`);
                } catch (e) {
                  console.warn(`[auto-merge] human-only-promote advisory for ${promoteSlug} failed:`, e instanceof Error ? e.message : e);
                }
              }
            } else {
              ok = false;
              console.warn(`[auto-merge] PR #${prNumber} (${branch}) was ready but ${m.reason}`);
            }
          } catch (e) {
            ok = false;
            console.warn(`[auto-merge] PR #${prNumber} merge threw:`, e instanceof Error ? e.message : e);
          }
        }
      }
      result.prs.push({ number: prNumber, branch, mergeableState, ready, buildGateOk, testsGateOk, merged });
    }
    return result;
  } catch (e) {
    ok = false;
    console.error("[auto-merge] gate failed:", e instanceof Error ? e.message : e);
    return result;
  } finally {
    // Control Tower liveness + action surfacing: one beat per pass (idle = ok:true/green; a failed merge
    // attempt = ok:false, feeding the error-rate assertion). Best-effort — never breaks the gate.
    await emitReactiveHeartbeat(AUTO_MERGE_GATE_LOOP_ID, {
      ok,
      produced: {
        enabled: result.enabled,
        syncActive: result.syncActive,
        checked: result.checked,
        ready: result.ready,
        buildGateBlocked: result.buildGateBlocked,
        testsGateBlocked: result.testsGateBlocked,
        accumulationBlocked: result.accumulationBlocked,
        goalBoundBlocked: result.goalBoundBlocked,
        foldGateBlocked: result.foldGateBlocked,
        merged: result.merged,
        mergedPr: result.mergedPr ?? null,
      },
    });
  }
}
