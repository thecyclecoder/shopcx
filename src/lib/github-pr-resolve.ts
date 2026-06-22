import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

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
