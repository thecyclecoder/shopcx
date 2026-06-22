import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { emitReactiveHeartbeat } from "@/lib/control-tower/heartbeat";
import { AUTO_MERGE_GATE_LOOP_ID } from "@/lib/control-tower/registry";

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

export interface DirtyPrResult {
  checked: number;
  conflicting: number;
  enqueued: number;
  prs: Array<{ number: number; branch: string; mergeable: boolean | null; enqueued: boolean }>;
}

/**
 * The webhook's whole job: list open `claude/*` PRs, find the newly-CONFLICTING ones, enqueue a
 * deduped pr-resolve job for each. Touches `claude/*` build branches ONLY (never a human PR). Bounded
 * and best-effort — a transient GitHub error on one PR doesn't block the others.
 */
export async function detectAndEnqueueDirtyPrs(admin?: Admin): Promise<DirtyPrResult> {
  const db = admin || createAdminClient();
  const result: DirtyPrResult = { checked: 0, conflicting: 0, enqueued: 0, prs: [] };
  if (!ghToken()) return result;

  const list = await gh("GET", `/repos/${GH_REPO}/pulls?state=open&per_page=100`);
  if (!list.ok || !Array.isArray(list.json)) return result;

  // claude/* build branches only — never touch a human PR or main directly (guardrail).
  const claudePrs = (list.json as Array<Record<string, unknown>>).filter((p) => {
    const ref = (p.head as { ref?: string } | undefined)?.ref || "";
    return typeof ref === "string" && ref.startsWith("claude/");
  });
  if (!claudePrs.length) return result;

  const workspaceId = await resolveBuildWorkspaceId(db);
  if (!workspaceId) return result;

  for (const p of claudePrs) {
    const prNumber = Number(p.number);
    const branch = (p.head as { ref?: string }).ref as string;
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
    if (mergeable === false) {
      result.conflicting++;
      try {
        const r = await enqueuePrResolveJob(db, { workspaceId, prNumber, branch });
        enqueued = r.enqueued;
        if (enqueued) result.enqueued++;
      } catch {
        /* best-effort — next event retries */
      }
    }
    result.prs.push({ number: prNumber, branch, mergeable, enqueued });
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
 */
export async function isAutoMergeEnabled(admin: Admin): Promise<boolean> {
  try {
    const workspaceId = await resolveBuildWorkspaceId(admin);
    if (!workspaceId) return true;
    const { data } = await admin.from("workspaces").select("*").eq("id", workspaceId).maybeSingle();
    const flag = (data as Record<string, unknown> | null)?.auto_merge_enabled;
    return flag !== false;
  } catch {
    return true;
  }
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
): Promise<{ merged: boolean; reason?: string }> {
  const body: Record<string, unknown> = { merge_method: "squash" };
  if (headSha) body.sha = headSha;
  const r = await gh("PUT", `/repos/${GH_REPO}/pulls/${prNumber}/merge`, body);
  if (!r.ok) {
    const msg = (r.json as Record<string, unknown>)?.message;
    return { merged: false, reason: `merge failed (${r.status}${msg ? `: ${msg}` : ""})` };
  }
  // Delete the merged branch (mirrors the owner's "delete branch" on squash-merge). Best-effort — a 404/422
  // (already gone / protected) is fine; the merge already landed.
  try {
    await gh("DELETE", `/repos/${GH_REPO}/git/refs/heads/${branch}`);
  } catch {
    /* best-effort branch cleanup */
  }
  return { merged: true };
}

export interface AutoMergeResult {
  enabled: boolean;
  syncActive: boolean;
  checked: number;
  ready: number;
  /** 0 or 1 — SERIALIZED: at most one merge per pass (the resulting push-to-main webhook handles the next). */
  merged: number;
  mergedPr?: number;
  prs: Array<{ number: number; branch: string; mergeableState: string | null; ready: boolean; merged: boolean }>;
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
 * Surfaces the pass as a Control Tower heartbeat (loop_id = AUTO_MERGE_GATE_LOOP_ID) + a console log.
 */
export async function autoMergeReadyPrs(admin?: Admin): Promise<AutoMergeResult> {
  const db = admin || createAdminClient();
  const result: AutoMergeResult = { enabled: true, syncActive: false, checked: 0, ready: 0, merged: 0, prs: [] };
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
      if (ready) {
        result.ready++;
        // SERIALIZE: only attempt the first ready PR — the post-merge push webhook drives the next one.
        if (result.merged === 0) {
          const headSha = (pr.head as { sha?: string } | undefined)?.sha;
          try {
            const m = await squashMergeAndDelete(prNumber, branch, headSha);
            if (m.merged) {
              merged = true;
              result.merged = 1;
              result.mergedPr = prNumber;
              console.log(`[auto-merge] squash-merged PR #${prNumber} (${branch}) + deleted branch`);
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
      result.prs.push({ number: prNumber, branch, mergeableState, ready, merged });
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
        merged: result.merged,
        mergedPr: result.mergedPr ?? null,
      },
    });
  }
}
