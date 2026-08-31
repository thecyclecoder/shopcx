/**
 * main-build-status — the red-main pipeline alarm
 * (a-red-main-is-a-first-class-pipeline-alarm Phase 1).
 *
 * Nothing else in the pipeline watches whether main is green. Every stuck-detector
 * reasons about a single spec in isolation, so a repo-wide breakage that blocks all
 * of them at once is exactly the shape none of them can see. On 2026-08-31 main was
 * red for ~40 minutes with every deploy failing while the pipeline reported itself
 * healthy (stuck=0), because the doctor only asked about spec state and never asked
 * whether main could build.
 *
 * This module fills the gap: `readMainBuildStatus` reads the combined build status of
 * main's HEAD commit via the same GitHub API path the rest of the codebase uses (the
 * `ghToken()` env var — no new auth path), walks back over recent commits when HEAD is
 * red to identify the FIRST commit in the red streak (the commit a human actually needs
 * to look at), and returns a compact verdict. `sweepMainBuildStatus` is the loop body:
 * on failure it records a `main_build_red` `director_activity` row + raises a CEO-visible
 * `dashboard_notifications` card, idempotent per `first_red_sha` so the every-5-minute
 * monitor tick can't fan out a new card each tick. On success it resolves any open card.
 *
 * The doctor ([[../pipeline-doctor]]) surfaces this on `PipelineDiagnosis.mainBuildRed`
 * so the board cannot claim health while main cannot build.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

const GH_REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
const MAIN_BRANCH = "main";

/** The bounded walk back from HEAD when finding the first red commit — a long-red main
 *  cannot make this unbounded (and no human needs to look past 20 commits anyway). */
export const MAIN_BUILD_STATUS_WALK_LIMIT = 20;

/** The `dashboard_notifications.type` the CEO-visible alarm card uses (matches the
 *  approval-request surface every other CEO-routed card lands on). */
const APPROVAL_REQUEST_TYPE = "agent_approval_request";

/** The `director_activity.action_kind` this alarm records under. */
export const MAIN_BUILD_RED_ACTION_KIND = "main_build_red";

/** The `metadata.escalation_kind` the CEO card lands under (same shape as ship-time-backfill /
 *  reconnect-required escalations — a single kind string a downstream router can key off). */
export const MAIN_BUILD_RED_ESCALATION_KIND = "main_build_red";

/** The director function that owns this alarm (Platform / DevOps — reliability). */
const PLATFORM_FUNCTION = "platform";

function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function ghGet(
  path: string,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${ghToken() ?? ""}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  return { ok: res.ok, status: res.status, json };
}

/** GitHub check-run conclusions that mean RED. `neutral` / `skipped` / `stale` are not red. */
const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);

/** GitHub combined commit-status states we normalize to. */
export type MainBuildState = "success" | "failure" | "pending" | "unknown";

interface CombinedStatusResponse {
  state?: string;
}
interface CheckRunsResponse {
  check_runs?: Array<{ conclusion?: string | null; status?: string | null }>;
}
interface CommitResponse {
  sha?: string;
  commit?: { message?: string };
}
interface CommitListRow {
  sha?: string;
  commit?: { message?: string };
}

/**
 * Read the combined build state of a single commit SHA — the union of GitHub commit
 * statuses (what Vercel + legacy CI post) and GitHub Actions check runs. Any red input
 * makes the whole state red; else pending trumps success; else success. `unknown` when
 * BOTH endpoints failed to read (a transient GitHub blip must NOT be reported as red).
 */
async function readCommitBuildState(sha: string): Promise<MainBuildState> {
  const [statusRes, checkRes] = await Promise.all([
    ghGet(`/repos/${GH_REPO}/commits/${encodeURIComponent(sha)}/status`),
    ghGet(`/repos/${GH_REPO}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`),
  ]);

  let anyRed = false;
  let anyPending = false;
  let anySignal = false;

  if (statusRes.ok) {
    anySignal = true;
    const combined = (statusRes.json as CombinedStatusResponse)?.state;
    if (combined === "failure" || combined === "error") anyRed = true;
    else if (combined === "pending") anyPending = true;
  }
  if (checkRes.ok) {
    anySignal = true;
    const runs = (checkRes.json as CheckRunsResponse)?.check_runs ?? [];
    for (const r of runs) {
      const conclusion = (r.conclusion ?? "").toLowerCase();
      const status = (r.status ?? "").toLowerCase();
      if (conclusion && FAILED_CHECK_CONCLUSIONS.has(conclusion)) {
        anyRed = true;
      } else if (status && status !== "completed") {
        anyPending = true;
      }
    }
  }

  if (!anySignal) return "unknown";
  if (anyRed) return "failure";
  if (anyPending) return "pending";
  return "success";
}

/**
 * The main branch's HEAD commit + a compact verdict on its combined build state, plus —
 * when RED — the OLDEST consecutive-red commit in the recent walk (that's the commit a
 * human needs; the head is downstream of it). Walk is bounded to
 * `MAIN_BUILD_STATUS_WALK_LIMIT` so a long-red main can't make this unbounded.
 *
 * Returns `{ state: 'unknown', ... }` when GitHub is unreachable — a transient blip is
 * NEVER promoted to a red-main alarm.
 */
export async function readMainBuildStatus(): Promise<{
  state: MainBuildState;
  headSha: string | null;
  firstRedSha: string | null;
  firstRedSubject: string | null;
}> {
  const commitsRes = await ghGet(
    `/repos/${GH_REPO}/commits?sha=${encodeURIComponent(MAIN_BRANCH)}&per_page=${MAIN_BUILD_STATUS_WALK_LIMIT}`,
  );
  if (!commitsRes.ok || !Array.isArray(commitsRes.json)) {
    return { state: "unknown", headSha: null, firstRedSha: null, firstRedSubject: null };
  }
  const commits = commitsRes.json as CommitListRow[];
  if (commits.length === 0) {
    return { state: "unknown", headSha: null, firstRedSha: null, firstRedSubject: null };
  }
  const headSha = commits[0]?.sha ?? null;
  if (!headSha) {
    return { state: "unknown", headSha: null, firstRedSha: null, firstRedSubject: null };
  }

  const headState = await readCommitBuildState(headSha);
  if (headState !== "failure") {
    return { state: headState, headSha, firstRedSha: null, firstRedSubject: null };
  }

  // HEAD is red — walk back through recent commits to find the OLDEST consecutive-red
  // one. As soon as we hit a green/pending commit we stop and take the previous red as
  // the first-red. When every walked commit is red we return the oldest walked commit
  // (bounded to MAIN_BUILD_STATUS_WALK_LIMIT). The walk is chronological (newest → oldest).
  let firstRedSha = headSha;
  let firstRedSubject = commits[0]?.commit?.message?.split("\n")[0] ?? null;
  for (let i = 1; i < commits.length; i++) {
    const sha = commits[i]?.sha;
    if (!sha) break;
    const state = await readCommitBuildState(sha);
    if (state !== "failure") break; // this commit is not red → the previous i-1 is the first red
    firstRedSha = sha;
    firstRedSubject = commits[i]?.commit?.message?.split("\n")[0] ?? firstRedSubject;
  }

  // Best-effort enrich: if we don't yet have a subject line, hit the commit endpoint.
  if (!firstRedSubject && firstRedSha) {
    const cRes = await ghGet(`/repos/${GH_REPO}/commits/${encodeURIComponent(firstRedSha)}`);
    if (cRes.ok) {
      const c = cRes.json as CommitResponse;
      firstRedSubject = c?.commit?.message?.split("\n")[0] ?? null;
    }
  }

  return { state: "failure", headSha, firstRedSha, firstRedSubject };
}

/**
 * The (effectively single-tenant) build-console workspace resolver — mirrors
 * [[../pipeline-doctor]]'s helper: ride the latest `agent_jobs` row, else the oldest
 * workspace. A repo-wide alarm is workspace-anchored so the CEO card lands in the
 * standard inbox scope (dashboard_notifications is workspace-scoped everywhere).
 */
async function resolveBuildConsoleWorkspaceId(admin: Admin): Promise<string | null> {
  const { data: job } = await admin
    .from("agent_jobs")
    .select("workspace_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fromJob = (job as { workspace_id?: string } | null)?.workspace_id;
  if (fromJob) return fromJob;
  const { data: ws } = await admin
    .from("workspaces")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (ws as { id?: string } | null)?.id ?? null;
}

interface SweepDeps {
  /** Injectable for tests. */
  read?: () => Promise<Awaited<ReturnType<typeof readMainBuildStatus>>>;
  /** Injectable for tests. */
  admin?: Admin;
  /** Injectable for tests. */
  workspaceId?: string;
}

export interface MainBuildSweepResult {
  state: MainBuildState;
  headSha: string | null;
  firstRedSha: string | null;
  firstRedSubject: string | null;
  /** Whether an alarm card was inserted THIS sweep (idempotent — false when today's
   *  first_red_sha already has an open card). */
  alarmed: boolean;
  /** Whether an open alarm was resolved THIS sweep (dismissed on green). */
  resolved: boolean;
  reason?: string;
}

/**
 * The monitored-loop body. Reads main's build state; on failure raises the alarm
 * IDEMPOTENTLY per `first_red_sha` (a monitor tick every 5 minutes cannot produce a
 * new card every tick for the same breakage — the same class as
 * `enqueueAuditSpecShippedStateIfDue` dedupes against). On success clears any open
 * alarm. `unknown` state is a no-op (a transient GitHub blip must never fake-clear).
 */
export async function sweepMainBuildStatus(deps: SweepDeps = {}): Promise<MainBuildSweepResult> {
  const admin = deps.admin ?? createAdminClient();
  const read = deps.read ?? readMainBuildStatus;

  const status = await read();

  if (status.state === "unknown") {
    return {
      state: "unknown",
      headSha: status.headSha,
      firstRedSha: status.firstRedSha,
      firstRedSubject: status.firstRedSubject,
      alarmed: false,
      resolved: false,
      reason: "github_unreachable",
    };
  }

  const workspaceId = deps.workspaceId ?? (await resolveBuildConsoleWorkspaceId(admin));
  if (!workspaceId) {
    return {
      state: status.state,
      headSha: status.headSha,
      firstRedSha: status.firstRedSha,
      firstRedSubject: status.firstRedSubject,
      alarmed: false,
      resolved: false,
      reason: "no_workspace",
    };
  }

  if (status.state === "success" || status.state === "pending") {
    // On green (or pending — the alarm only fires on RED), dismiss any still-open card
    // so a resolved outage doesn't stay lit on the board. Guarded by `dismissed:false`
    // so we only touch open rows.
    let resolved = false;
    try {
      const { data: open } = await admin
        .from("dashboard_notifications")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("type", APPROVAL_REQUEST_TYPE)
        .eq("metadata->>escalation_kind", MAIN_BUILD_RED_ESCALATION_KIND)
        .eq("dismissed", false);
      const rows = (open ?? []) as { id: string }[];
      if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        const { error } = await admin
          .from("dashboard_notifications")
          .update({ dismissed: true })
          .in("id", ids)
          .eq("dismissed", false);
        if (!error) resolved = true;
      }
    } catch (err) {
      console.warn(
        "[main-build-status] resolve-on-green failed:",
        err instanceof Error ? err.message : err,
      );
    }
    return {
      state: status.state,
      headSha: status.headSha,
      firstRedSha: null,
      firstRedSubject: null,
      alarmed: false,
      resolved,
    };
  }

  // state === 'failure'
  const firstRedSha = status.firstRedSha ?? status.headSha;
  if (!firstRedSha) {
    return {
      state: status.state,
      headSha: status.headSha,
      firstRedSha: null,
      firstRedSubject: null,
      alarmed: false,
      resolved: false,
      reason: "no_first_red_sha",
    };
  }

  const dedupeKey = `main_build_red:${firstRedSha}`;

  // Dedupe: at most ONE open card per first_red_sha. A prior OPEN card short-circuits.
  try {
    const { data: prior } = await admin
      .from("dashboard_notifications")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("type", APPROVAL_REQUEST_TYPE)
      .eq("metadata->>dedupe_key", dedupeKey)
      .limit(1);
    if ((prior ?? []).length > 0) {
      return {
        state: status.state,
        headSha: status.headSha,
        firstRedSha,
        firstRedSubject: status.firstRedSubject,
        alarmed: false,
        resolved: false,
        reason: "deduped",
      };
    }
  } catch (err) {
    console.warn(
      "[main-build-status] prior-card lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return {
      state: status.state,
      headSha: status.headSha,
      firstRedSha,
      firstRedSubject: status.firstRedSubject,
      alarmed: false,
      resolved: false,
      reason: "lookup_failed",
    };
  }

  const subject = status.firstRedSubject ?? "(subject unavailable)";
  const shortSha = firstRedSha.slice(0, 7);
  const headShortSha = status.headSha ? status.headSha.slice(0, 7) : "(unknown)";
  const title = `main is red — first broken commit ${shortSha} "${subject.slice(0, 100)}"`;
  const body =
    `🚨 main cannot build. Every production deploy is failing until this is resolved.\n\n` +
    `First red commit: ${firstRedSha}\n` +
    `Subject: ${subject}\n` +
    `Current HEAD: ${headShortSha}\n\n` +
    `The deploy build gate that exists to catch this class of failure only runs inside the box ` +
    `build lane; a hand-authored hotfix branch (or any PR merged by hand in the GitHub UI) ` +
    `bypasses it. This alarm is the backstop.\n\n` +
    `Diagnose: check the failing checks on ${firstRedSha} on GitHub. Fix: revert the commit or ` +
    `push the follow-up that makes main green. This card auto-dismisses when the next sweep sees ` +
    `main green again.`;

  const link = `https://github.com/${GH_REPO}/commit/${firstRedSha}`;

  let alarmed = false;
  try {
    const { error } = await admin.from("dashboard_notifications").insert({
      workspace_id: workspaceId,
      type: APPROVAL_REQUEST_TYPE,
      title: title.slice(0, 200),
      body: body.slice(0, 4000),
      link,
      metadata: {
        routed_to_function: "ceo",
        escalated_by_director: PLATFORM_FUNCTION,
        escalation_kind: MAIN_BUILD_RED_ESCALATION_KIND,
        head_sha: status.headSha,
        first_red_sha: firstRedSha,
        first_red_subject: status.firstRedSubject,
        dedupe_key: dedupeKey,
        approve_action_id: null,
      },
      read: false,
      dismissed: false,
    });
    if (!error) alarmed = true;
    else {
      console.warn("[main-build-status] card insert failed:", error.message);
    }
  } catch (err) {
    console.warn(
      "[main-build-status] card insert threw:",
      err instanceof Error ? err.message : err,
    );
  }

  // Always record the director_activity row when we raise a fresh alarm — that's the
  // audit trail the recap reads back. Dedupe here too: at most one `main_build_red`
  // director_activity row per first_red_sha (best-effort read; the card dedupe is the
  // authoritative one, this is a secondary guard against a rare double-write).
  try {
    const { data: priorAct } = await admin
      .from("director_activity")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("action_kind", MAIN_BUILD_RED_ACTION_KIND)
      .eq("metadata->>first_red_sha", firstRedSha)
      .limit(1);
    if ((priorAct ?? []).length === 0) {
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: PLATFORM_FUNCTION,
        actionKind: MAIN_BUILD_RED_ACTION_KIND,
        reason:
          `main is red — first broken commit ${firstRedSha} ("${subject}"). ` +
          `Head ${status.headSha ?? "(unknown)"}. Every deploy is failing until this is resolved.`,
        metadata: {
          head_sha: status.headSha,
          first_red_sha: firstRedSha,
          first_red_subject: status.firstRedSubject,
          autonomous: true,
        },
      });
    }
  } catch (err) {
    console.warn(
      "[main-build-status] director_activity write failed:",
      err instanceof Error ? err.message : err,
    );
  }

  return {
    state: status.state,
    headSha: status.headSha,
    firstRedSha,
    firstRedSubject: status.firstRedSubject,
    alarmed,
    resolved: false,
  };
}
