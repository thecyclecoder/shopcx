/**
 * libraries/preview-capture — per-build Vercel preview-URL capture path for
 * [[../specs/per-build-vercel-preview-deploys]] Phase 2.
 *
 * One `claude/*` build branch = one Vercel preview deployment (Phase 1 flipped the
 * Ignored-Build-Step so `claude/*` builds). This module resolves that deployment via
 * [[vercel-project]] `getLatestReadyDeploymentForBranch` and persists it on the owning
 * [[../tables/agent_jobs]] row:
 *
 *   - `preview_url`   the `https://…vercel.app` URL of the latest READY deployment for the branch.
 *                     Set ONCE the deployment reaches READY; null while it's still BUILDING / unmatched.
 *   - `preview_state` the latest known Vercel state (`QUEUED` / `INITIALIZING` / `BUILDING` / `READY` /
 *                     `ERROR` / `CANCELED`) — M3 reads "preview exists" from this.
 *
 * Read-only against Vercel — this module cannot promote or merge anything (that is M4's
 * bounded action). Best-effort + idempotent by design:
 *   - the worker calls this ONCE after the push succeeds (single, non-blocking poll);
 *   - a missing/late deployment leaves `preview_state` at BUILDING (or null) and is NEVER fatal;
 *   - a re-call (a polling cron, M3's spec-test enqueue, or a board refresh) is safe — the helper
 *     reads the current row + skips the write when the URL+state already match.
 *
 * Hard rail: refuses to capture for a non-`claude/*` branch (prod or any other ref). The deployment
 * lookup it calls already refuses `main`/`master`, but this is the second belt: the capture is for
 * per-build PREVIEW deployments, never prod.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import {
  getLatestReadyDeploymentForBranch,
  previewHttpsUrl,
  type DeploymentState,
} from "@/lib/vercel-project";

export interface PreviewCaptureResult {
  /** Whether the agent_jobs row was actually updated (false on no-op / unchanged / no-branch). */
  updated: boolean;
  /** The persisted preview URL after the capture, or null if none yet. */
  previewUrl: string | null;
  /** The persisted deployment state after the capture, or null if Vercel hasn't picked the branch up yet. */
  previewState: DeploymentState | null;
  /** Why the capture no-op'd, if it did. */
  reason?: string;
}

export interface CaptureOptions {
  /** The agent_jobs row id whose preview_url + preview_state to persist. */
  jobId: string;
  /** The `claude/*` build branch the worker pushed (job.spec_branch). */
  branch: string | null;
  /** The build commit SHA (preferred match for the deployment). Optional. */
  commitSha?: string | null;
}

export interface PollOptions {
  /** Milliseconds between Vercel lookups. Default 15_000 (15s). */
  intervalMs?: number;
  /** Total wall-clock budget. Default 360_000 (6 min — Vercel previews usually READY ≤ 5 min). */
  timeoutMs?: number;
  /** Optional log sink; defaults to `console.log`. */
  log?: (msg: string) => void;
}

/**
 * Look up the latest preview deployment for `branch` on Vercel and persist its URL + state on the
 * `agent_jobs` row `jobId`. Returns what was captured. Best-effort: never throws — every error is
 * swallowed into a `reason` string so the caller (the build worker) never fails the build on a
 * preview-lookup hiccup. Re-callable / idempotent: a second call with the same Vercel state writes
 * nothing.
 */
export async function capturePreviewUrlForJob(opts: CaptureOptions): Promise<PreviewCaptureResult> {
  const { jobId, branch, commitSha } = opts;

  if (!branch || !branch.startsWith("claude/")) {
    return { updated: false, previewUrl: null, previewState: null, reason: "not a claude/* branch" };
  }

  let lookup: Awaited<ReturnType<typeof getLatestReadyDeploymentForBranch>>;
  try {
    lookup = await getLatestReadyDeploymentForBranch(branch, commitSha ?? null);
  } catch (e) {
    return {
      updated: false,
      previewUrl: null,
      previewState: null,
      reason: `vercel lookup failed: ${errText(e)}`,
    };
  }

  // Prefer the READY deployment when present (the URL we want to persist). Fall back to the latest
  // of any state so M3 can see "preview exists / still BUILDING" before READY lands.
  const chosen = lookup.ready ?? lookup.latest;
  const previewUrl = chosen?.state === "READY" ? previewHttpsUrl(chosen) : null;
  const previewState = chosen?.state ?? null;

  // Read the current row + only update when something actually changes — idempotent re-poll.
  const admin = createAdminClient();
  const { data: current, error: readErr } = await admin
    .from("agent_jobs")
    .select("preview_url, preview_state")
    .eq("id", jobId)
    .maybeSingle();
  if (readErr) {
    return {
      updated: false,
      previewUrl,
      previewState,
      reason: `read agent_jobs failed: ${readErr.message}`,
    };
  }
  if (!current) {
    return { updated: false, previewUrl, previewState, reason: "agent_jobs row not found" };
  }

  const curUrl = (current.preview_url as string | null) ?? null;
  const curState = (current.preview_state as string | null) ?? null;
  if (curUrl === previewUrl && curState === previewState) {
    return { updated: false, previewUrl, previewState, reason: "unchanged" };
  }

  // Don't NULL OUT an already-persisted URL on a re-poll that briefly fails to surface the READY
  // deployment (Vercel listing is eventually-consistent). Only ADVANCE the URL forward — write
  // the new URL or keep the prior one; let the state column reflect the latest known state.
  const nextUrl = previewUrl ?? curUrl;
  if (nextUrl === curUrl && previewState === curState) {
    return { updated: false, previewUrl: nextUrl, previewState, reason: "unchanged" };
  }
  const { error: writeErr } = await admin
    .from("agent_jobs")
    .update({ preview_url: nextUrl, preview_state: previewState })
    .eq("id", jobId);
  if (writeErr) {
    return {
      updated: false,
      previewUrl: nextUrl,
      previewState,
      reason: `update agent_jobs failed: ${writeErr.message}`,
    };
  }
  return { updated: true, previewUrl: nextUrl, previewState };
}

/**
 * Poll [[capturePreviewUrlForJob]] until the build's preview deployment reaches READY or the
 * timeout elapses. Each iteration writes the latest known state to the job row (idempotent +
 * advances `preview_url` only forward), so even an interrupted poll leaves M3-actionable signal
 * on the row.
 *
 * The worker calls this fire-and-forget (`void pollCapturePreviewUrl(...)`) right after the push
 * succeeds: Vercel hasn't picked the branch up yet, but by the time the first 15s tick elapses
 * the deployment is usually QUEUED → BUILDING → READY within ~5 min. Best-effort — caught/logged,
 * never throws. A worker restart drops in-flight polls; a future cron / M3's pre-merge enqueue
 * re-polls the same idempotent helper.
 */
export async function pollCapturePreviewUrl(
  opts: CaptureOptions,
  poll: PollOptions = {},
): Promise<PreviewCaptureResult> {
  const intervalMs = poll.intervalMs ?? 15_000;
  const timeoutMs = poll.timeoutMs ?? 6 * 60_000;
  const log = poll.log ?? ((msg) => console.log(msg));
  const deadline = Date.now() + timeoutMs;

  let last: PreviewCaptureResult = {
    updated: false,
    previewUrl: null,
    previewState: null,
    reason: "not yet polled",
  };
  try {
    while (Date.now() < deadline) {
      last = await capturePreviewUrlForJob(opts);
      if (last.previewState === "READY" && last.previewUrl) {
        log(`preview-capture: ${opts.jobId} READY → ${last.previewUrl}`);
        return last;
      }
      if (last.previewState === "ERROR" || last.previewState === "CANCELED") {
        log(`preview-capture: ${opts.jobId} terminal ${last.previewState} — stopping poll`);
        return last;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    log(`preview-capture: ${opts.jobId} timeout after ${Math.round(timeoutMs / 1000)}s — last state=${last.previewState ?? "null"}`);
  } catch (e) {
    log(`preview-capture: ${opts.jobId} poll error: ${errText(e)}`);
  }
  return last;
}
