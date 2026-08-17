// libraries/vercel-project — Vercel REST API helper for the project's build-gate (the
// Ignored-Build-Step) and per-branch preview-deployment lookup. The narrow API surface the
// per-build-preview pipeline needs (preview-test-promote-pipeline M1):
//
//   - patchIgnoredBuildStep(): idempotently PATCH commandForIgnoringBuildStep so ONLY a SPEC-BUILD
//     branch (`claude/build-*`, the runBuildJob lane that genuinely needs a preview for spec-testing)
//     produces a Vercel preview deployment, while every incidental branch — incl. every OTHER foreman
//     lane (`claude/fold-*`, `claude/goal-fold-*`, `claude/plan-*`, `claude/spec-chat-*`, …) — is
//     skipped. Reads the current value first, surfaces the before/after, and only writes when it
//     differs — the supervisable-autonomy reasoning trail.
//
//   - getLatestReadyDeploymentForBranch(): the read-only deployments lookup used by the preview
//     capture path (M1 Phase 2) to resolve a build's preview URL once Vercel reports READY.
//
// No mutating action is taken outside patchIgnoredBuildStep. The capture path is read-only
// against Vercel — neither helper can promote or merge anything.
//
// Token: prefers VERCEL_API_TOKEN (already used by the storefront-experiment manifest + portal
// integration paths), falls back to VERCEL_TOKEN. NEVER hardcoded.

const PROJECT_ID = "prj_80PnLIjdKT4YAxITnbjkTCgbP0Qv";
const TEAM_ID = "team_7VetGZ2S7RsYHDoX2bSoB6En";

// The exact override command the goal records (preview-test-promote-pipeline, 2026-06-26;
// narrowed to spec-builds only 2026-06-27 — vercel-skip-non-spec-build-refs).
// Build production AND ONLY a SPEC-BUILD ref (`claude/build-*` — runBuildJob's lane, the one that
// needs a preview for pre-merge spec-testing); SKIP everything else, incl. every OTHER foreman lane
// (`claude/fold-*`, `claude/goal-fold-*`, `claude/plan-*`, `claude/spec-chat-*`, `claude/dev-ask-*`,
// `claude/director-coach-*`) and every incidental topic branch. A whitelist, not a blacklist: a new
// foreman lane added later is skip-by-default unless it adopts the `claude/build-` prefix. The
// single-line shell form Vercel runs in /bin/sh — `exit 1` means BUILD, `exit 0` means SKIP.
export const CLAUDE_PREVIEW_IGNORE_COMMAND =
  `if [ "$VERCEL_ENV" = production ] || echo "$VERCEL_GIT_COMMIT_REF" | grep -q '^claude/build-'; then exit 1; else exit 0; fi`;

function vercelToken(): string {
  const t = process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
  if (!t) throw new Error("vercel-project: VERCEL_API_TOKEN (or VERCEL_TOKEN) not set in env");
  return t;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${vercelToken()}`,
    "Content-Type": "application/json",
  };
}

function projectUrl(): string {
  return `https://api.vercel.com/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`;
}

export type ProjectIgnoreState = {
  commandForIgnoringBuildStep: string | null;
};

export async function getProjectIgnoreState(): Promise<ProjectIgnoreState> {
  const res = await fetch(projectUrl(), { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`vercel-project: GET project failed: ${res.status} ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as { commandForIgnoringBuildStep?: string | null };
  return { commandForIgnoringBuildStep: json.commandForIgnoringBuildStep ?? null };
}

export type PatchIgnoreResult = {
  before: string | null;
  after: string;
  changed: boolean;
};

/**
 * Idempotently PATCH the project's commandForIgnoringBuildStep to the `desired` command
 * (defaults to CLAUDE_PREVIEW_IGNORE_COMMAND). Reads the current value first; PATCHes only
 * when it differs. Returns + console-logs the before/after so the override is auditable.
 */
export async function patchIgnoredBuildStep(desired: string = CLAUDE_PREVIEW_IGNORE_COMMAND): Promise<PatchIgnoreResult> {
  const current = await getProjectIgnoreState();
  const before = current.commandForIgnoringBuildStep;
  if (before === desired) {
    console.log(`vercel-project: commandForIgnoringBuildStep already matches — no-op.\n  command: ${desired}`);
    return { before, after: desired, changed: false };
  }
  const res = await fetch(projectUrl(), {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ commandForIgnoringBuildStep: desired }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`vercel-project: PATCH project failed: ${res.status} ${body.slice(0, 500)}`);
  }
  console.log(
    `vercel-project: commandForIgnoringBuildStep updated.\n  before: ${before ?? "<unset>"}\n  after:  ${desired}`,
  );
  return { before, after: desired, changed: true };
}

// ── Deployments lookup (read-only) ────────────────────────────────────────────────────────

export type DeploymentState =
  | "QUEUED"
  | "BUILDING"
  | "READY"
  | "ERROR"
  | "CANCELED"
  | "INITIALIZING";

export type Deployment = {
  uid: string;
  url: string; // host (no scheme), e.g. shopcx-abc123.vercel.app
  state: DeploymentState;
  target: "production" | "staging" | null;
  meta: Record<string, string | undefined>;
  createdAt: number;
};

type DeploymentsListResponse = {
  deployments: Array<{
    uid: string;
    url: string;
    state?: DeploymentState;
    readyState?: DeploymentState;
    target?: "production" | "staging" | null;
    meta?: Record<string, string | undefined>;
    createdAt: number;
  }>;
};

/**
 * Read-only: list the most recent deployments for a `claude/*` build branch, newest first.
 * Filters by `projectId` and `git branch` so prod (main) deployments are never returned.
 * `limit` defaults to 20 (Vercel's per-page max is 100; the latest READY for a branch is
 * almost always among the first few).
 */
export async function listDeploymentsForBranch(branch: string, limit = 20): Promise<Deployment[]> {
  if (!branch || branch === "main" || branch === "master") {
    // Hard rail: this helper is for branch previews only — never resolve a prod URL.
    throw new Error(`vercel-project: refusing to list deployments for non-preview branch "${branch}"`);
  }
  const params = new URLSearchParams({
    projectId: PROJECT_ID,
    teamId: TEAM_ID,
    "meta-githubCommitRef": branch,
    limit: String(limit),
  });
  const url = `https://api.vercel.com/v6/deployments?${params.toString()}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`vercel-project: GET deployments failed: ${res.status} ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as DeploymentsListResponse;
  return (json.deployments || []).map((d) => ({
    uid: d.uid,
    url: d.url,
    state: (d.state ?? d.readyState ?? "QUEUED") as DeploymentState,
    target: d.target ?? null,
    meta: d.meta ?? {},
    createdAt: d.createdAt,
  }));
}

export type LatestDeploymentLookup = {
  /** The newest deployment for the branch, regardless of state. null if Vercel hasn't picked the branch up yet. */
  latest: Deployment | null;
  /**
   * The READY deployment for the caller's request. When `commitSha` is supplied, this is ONLY set to
   * the READY deployment whose `meta.githubCommitSha` matches — no cross-SHA substitution
   * (a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 3). When
   * `commitSha` is omitted, this is the newest READY on the branch (regardless of commit).
   */
  ready: Deployment | null;
  /**
   * a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 3 — the
   * distinguishable "did we find what you asked for" signal. `true` iff `ready` satisfies the
   * caller's request: (a) `commitSha` supplied AND a READY deployment for THAT sha was found, or
   * (b) `commitSha` omitted AND at least one READY deployment exists on the branch. `false` on a
   * SHA-miss (no READY for the requested `commitSha` — the caller can tell "no preview for THIS
   * sha yet" apart from "no preview at all" using `latestReadyOnBranch` below).
   */
  readyForRequestedSha: boolean;
  /**
   * a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 3 — the newest
   * READY on the branch REGARDLESS of commit SHA. Always populated so a caller can distinguish
   * "no preview at all" (`null`) from "preview exists but for a different commit" (non-null with
   * `ready === null` on a SHA-supplied miss). Never used as a substitute for `ready` — this is
   * observability only.
   */
  latestReadyOnBranch: Deployment | null;
};

/**
 * Resolve the preview deployment for a `claude/*` build branch:
 *   - `latest`: newest of any state (so the caller can show "still BUILDING")
 *   - `ready`:  the READY deployment for the caller's request (see below)
 *   - `readyForRequestedSha`: `true` iff `ready` satisfies the caller's request
 *   - `latestReadyOnBranch`: the newest READY on the branch regardless of commit — for observability
 *
 * ⭐ a-branch-security-review-is-fresh-only-for-the-exact-head-sha-it-reviewed Phase 3 — the SHA-scoped
 * miss no longer substitutes another commit's deployment. When `commitSha` is supplied and no READY
 * matches that exact SHA, `ready` is `null` and `readyForRequestedSha` is `false` — the caller can
 * tell "no preview for this SHA yet" apart from "no preview at all" (the branch's newest READY, if
 * any, is exposed under `latestReadyOnBranch` for observability, NEVER for substitution). This closes
 * the 2026-08-17 defect: merge commit `d8727bf05` (14:05) produced no deployment; between 14:05 and
 * the next successful deploy at 14:27, the old fallback would have returned `7bf057e97`'s pre-merge
 * build as "the branch's ready preview", and any pre-merge check pointed at that origin would have
 * verified code the branch no longer had.
 *
 * When `commitSha` is OMITTED, the caller is asking for the branch's newest preview and a substitution
 * is not possible — `ready` returns the newest READY on the branch, exactly as before.
 *
 * Production deployments are filtered out — `target: "production"` is excluded.
 */
export async function getLatestReadyDeploymentForBranch(
  branch: string,
  commitSha?: string | null,
): Promise<LatestDeploymentLookup> {
  const deployments = await listDeploymentsForBranch(branch);
  const previews = deployments.filter((d) => d.target !== "production");
  const latest = previews[0] ?? null;
  const readyOnly = previews.filter((d) => d.state === "READY");
  const latestReadyOnBranch = readyOnly[0] ?? null;
  // Phase 3: a supplied commitSha binds `ready` STRICTLY to a READY deployment for that exact SHA.
  // No fallback to `latestReadyOnBranch` — a caller asking about a specific commit needs "yes / no /
  // wait", never a silent substitution. A caller that omits `commitSha` is asking about the branch's
  // newest preview, so `ready` falls back to `latestReadyOnBranch` (unchanged behavior).
  let ready: Deployment | null = null;
  let readyForRequestedSha = false;
  if (commitSha) {
    ready = readyOnly.find((d) => d.meta.githubCommitSha === commitSha) ?? null;
    readyForRequestedSha = ready !== null;
  } else {
    ready = latestReadyOnBranch;
    readyForRequestedSha = ready !== null;
  }
  return { latest, ready, readyForRequestedSha, latestReadyOnBranch };
}

/** The preview URL (with https://) for a deployment row, or null if none. */
export function previewHttpsUrl(d: Deployment | null): string | null {
  if (!d) return null;
  return d.url.startsWith("http") ? d.url : `https://${d.url}`;
}

// Exposed for the brain page + tests — never used to bypass the env read.
export const VERCEL_PROJECT_IDS = { PROJECT_ID, TEAM_ID } as const;
