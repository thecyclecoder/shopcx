/**
 * builder-worker — the box-side build worker for the Roadmap Build Console.
 *
 * Runs on the self-hosted box (Hetzner CCX33, tailnet-locked). Polls the agent_jobs
 * queue OUTBOUND (no inbound port), claims a job via claim_agent_job(), runs the spec
 * build as a headless `claude -p` on the Max subscription (ANTHROPIC_API_KEY stripped),
 * gates on tsc, and opens a claude/* PR. Pauses with structured questions on needs_input
 * and resumes the same session once answered.  See docs/brain/specs/roadmap-build-console.md.
 *
 * Run:  cd /root/shopcx && npx tsx scripts/builder-worker.ts
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";

const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const REPO_DIR = resolve(__dirname, "..");
const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN || "";
const POLL_MS = 5000;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

type JobStatus = "queued" | "claimed" | "building" | "needs_input" | "needs_approval" | "queued_resume" | "completed" | "failed" | "needs_attention";
interface PendingAction {
  id: string;
  type: "apply_migration" | "run_prod_script" | "merge_pr";
  summary: string;
  cmd?: string;
  preview?: string;
  status: "pending" | "approved" | "declined" | "done" | "failed";
  result?: string;
}
interface Job {
  id: string;
  spec_slug: string;
  spec_branch: string | null;
  status: JobStatus;
  claude_session_id: string | null;
  instructions: string | null;
  answers: { id: string; answer: string }[];
  pending_actions: PendingAction[];
  pr_number: number | null;
}

async function admin() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  return createAdminClient();
}

function sh(cmd: string, args: string[], opts: { timeout?: number } = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout });
  return { code: r.status ?? -1, out: r.stdout || "", err: r.stderr || "" };
}

// A fresh box has no git identity → `git commit` errors. Set it (repo-local) so the worker is self-contained.
function ensureGitIdentity() {
  sh("git", ["config", "user.email", "builder@shopcx.ai"]);
  sh("git", ["config", "user.name", "ShopCX Build Worker"]);
}

function runClaude(prompt: string, sessionId: string | null) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // belt-and-suspenders: stay on Max
  const base = sessionId ? ["--resume", sessionId] : [];
  const args = [...base, "-p", prompt, "--permission-mode", "acceptEdits", "--output-format", "json"];
  const r = spawnSync("claude", args, { cwd: REPO_DIR, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: BUILD_TIMEOUT_MS });
  let session = sessionId;
  let resultText = "";
  let isError = r.status !== 0;
  try {
    const obj = JSON.parse((r.stdout || "").trim());
    session = obj.session_id || session;
    resultText = typeof obj.result === "string" ? obj.result : JSON.stringify(obj);
    isError = isError || obj.is_error === true;
  } catch {
    resultText = (r.stdout || "") + (r.stderr || "");
  }
  return { session, resultText, isError, raw: (r.stdout || "") + (r.stderr || "") };
}

function parseStatus(text: string): { status: string; questions?: unknown[]; summary?: string } | null {
  const tryParse = (s: string) => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" && "status" in o ? o : null;
    } catch {
      return null;
    }
  };
  let o = tryParse(text.trim());
  if (o) return o;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    o = tryParse(fence[1].trim());
    if (o) return o;
  }
  const idx = text.indexOf('{"status"');
  if (idx >= 0) {
    const last = text.lastIndexOf("}");
    if (last > idx) o = tryParse(text.slice(idx, last + 1));
    if (o) return o;
  }
  return null;
}

async function gh(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? JSON.parse(text) : {} };
}

async function ensurePr(branch: string, title: string, draft: boolean): Promise<{ url: string; number: number } | null> {
  const owner = REPO.split("/")[0];
  const created = await gh("POST", `/repos/${REPO}/pulls`, {
    title,
    head: branch,
    base: "main",
    body: `Automated build of \`docs/brain/specs/${title}\` by the box worker. ${draft ? "**Draft — has open questions.**" : ""}`,
    draft,
  });
  if (created.ok) return { url: created.json.html_url as string, number: created.json.number as number };
  // already exists?
  const existing = await gh("GET", `/repos/${REPO}/pulls?head=${owner}:${branch}&state=open`);
  if (existing.ok && Array.isArray(existing.json) && existing.json.length) {
    return { url: existing.json[0].html_url as string, number: existing.json[0].number as number };
  }
  return null;
}

let db: Awaited<ReturnType<typeof admin>>;

async function update(id: string, patch: Record<string, unknown>) {
  await db.from("agent_jobs").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id);
}

// Execute owner-approved gated actions. The worker is the ONLY component with prod creds;
// it runs exactly the command the owner approved (shown to them as the preview).
async function executeApprovedActions(job: Job): Promise<{ actions: PendingAction[]; summary: string }> {
  const actions = (job.pending_actions || []).map((a) => ({ ...a }));
  const done: string[] = [];
  for (const a of actions) {
    if (a.status !== "approved") continue;
    try {
      if (a.type === "merge_pr") {
        const r = await gh("PUT", `/repos/${REPO}/pulls/${job.pr_number}/merge`, { merge_method: "squash" });
        a.status = r.ok ? "done" : "failed";
        a.result = r.ok ? "merged" : `merge failed ${r.status}`;
      } else if (a.cmd) {
        const r = sh("bash", ["-lc", a.cmd], { timeout: 10 * 60 * 1000 });
        a.status = r.code === 0 ? "done" : "failed";
        a.result = (r.out + r.err).slice(-500);
      } else {
        a.status = "failed";
        a.result = "no command to run";
      }
    } catch (e) {
      a.status = "failed";
      a.result = e instanceof Error ? e.message : String(e);
    }
    done.push(`${a.summary} → ${a.status}`);
  }
  return { actions, summary: done.join("; ") };
}

async function runJob(job: Job) {
  const slug = job.spec_slug;
  const isResume = !!job.claude_session_id;
  const tag = `[${slug}]`;
  console.log(`${tag} ${isResume ? "resuming" : "building"} (job ${job.id})`);

  let branch = job.spec_branch;
  if (!isResume) {
    branch = `claude/${slug}-${Date.now().toString(36)}`;
    sh("git", ["fetch", "origin"]);
    const co = sh("git", ["checkout", "-B", branch, "origin/main"]);
    if (co.code !== 0) throw new Error(`git checkout failed: ${co.err.slice(0, 300)}`);
    await update(job.id, { spec_branch: branch });
  } else {
    sh("git", ["checkout", branch!]);
  }

  // On an approval-resume, execute the owner-approved gated actions FIRST (worker has prod creds), then resume.
  let executedSummary = "";
  if (isResume && (job.pending_actions || []).some((a) => a.status === "approved")) {
    const { actions, summary } = await executeApprovedActions(job);
    await update(job.id, { pending_actions: actions });
    executedSummary = summary;
    console.log(`${tag} executed approved actions: ${summary}`);
  }

  const resumeBits: string[] = [];
  if ((job.answers || []).length) resumeBits.push(`Answers to your questions: ${JSON.stringify(job.answers)}`);
  if (executedSummary) resumeBits.push(`Gated actions executed: ${executedSummary}`);

  const prompt = isResume
    ? `${resumeBits.join(". ") || "Resuming."}. Continue implementing docs/brain/specs/${slug}.md and finish. Same rules and the same final JSON output protocol as before.`
    : [
        `Use the build-spec skill to implement the spec at docs/brain/specs/${slug}.md (cwd is the repo root).`,
        ...(job.instructions ? [`SCOPE for THIS build — do exactly this and nothing more: ${job.instructions}`] : []),
        `Worker protocol (overrides the skill's git step): the harness owns version control — do NOT run git/push or open a PR. Author migrations/scripts as code (write-migration skill). You have NO prod credentials: to apply a migration or run a prod-mutating script, request approval instead of doing it. Run \`npx tsc --noEmit\` and fix errors you introduce. If you hit a product decision the spec doesn't cover, do NOT guess.`,
        `Final message = ONLY one JSON object: {"status":"completed","summary":"…"} | {"status":"needs_input","questions":[{"id","q"}]} | {"status":"needs_approval","actions":[{"type":"apply_migration|run_prod_script","summary":"what & why","cmd":"exact command, e.g. npx tsx scripts/apply-X-migration.ts"}]}.`,
      ].join("\n");

  const { session, resultText, isError, raw } = runClaude(prompt, job.claude_session_id);
  const logTail = raw.slice(-2000);
  if (session) await update(job.id, { claude_session_id: session });

  const parsed = parseStatus(resultText);
  console.log(`${tag} claude finished — parsed status: ${parsed?.status ?? "(none)"} isError=${isError}`);

  if (parsed?.status === "needs_input") {
    if (sh("git", ["status", "--porcelain"]).out.trim()) {
      sh("git", ["add", "-A"]);
      sh("git", ["commit", "-m", `wip: ${slug} (needs input)`]);
      sh("git", ["push", "-u", "origin", branch!]);
    }
    const pr = await ensurePr(branch!, slug, true);
    await update(job.id, {
      status: "needs_input",
      questions: parsed.questions ?? [],
      log_tail: logTail,
      pr_url: pr?.url ?? null,
      pr_number: pr?.number ?? null,
    });
    return;
  }

  if (parsed?.status === "needs_approval") {
    const incoming: Array<Record<string, unknown>> = Array.isArray((parsed as Record<string, unknown>).actions)
      ? ((parsed as Record<string, unknown>).actions as Array<Record<string, unknown>>)
      : [];
    const pending: PendingAction[] = incoming.map((a, i) => {
      const cmd = typeof a.cmd === "string" ? a.cmd : undefined;
      const type = a.type === "merge_pr" || a.type === "run_prod_script" ? (a.type as PendingAction["type"]) : "apply_migration";
      return {
        id: `a${Date.now().toString(36)}${i}`,
        type,
        summary: String(a.summary || cmd || "gated action"),
        cmd,
        preview: typeof a.preview === "string" ? a.preview : cmd,
        status: "pending",
      };
    });
    if (sh("git", ["status", "--porcelain"]).out.trim()) {
      sh("git", ["add", "-A"]);
      sh("git", ["commit", "-m", `wip: ${slug} (needs approval)`]);
      sh("git", ["push", "-u", "origin", branch!]);
    }
    const pr = await ensurePr(branch!, slug, true);
    await update(job.id, {
      status: "needs_approval",
      pending_actions: pending,
      log_tail: logTail,
      pr_url: pr?.url ?? null,
      pr_number: pr?.number ?? null,
    });
    return;
  }

  if (isError && !parsed) {
    await update(job.id, { status: "failed", error: "claude run errored", log_tail: logTail });
    return;
  }

  // completed path: gate on tsc
  const tsc = sh("npx", ["tsc", "--noEmit"], { timeout: 10 * 60 * 1000 });
  if (tsc.code !== 0) {
    await update(job.id, { status: "failed", error: "tsc failed", log_tail: (tsc.out + tsc.err).slice(-2000) });
    return;
  }

  const dirty = sh("git", ["status", "--porcelain"]).out.trim();
  if (!dirty) {
    await update(job.id, { status: "completed", log_tail: "no file changes; nothing to commit" });
    return;
  }
  sh("git", ["add", "-A"]);
  const commit = sh("git", ["commit", "-m", `build: ${slug}\n\n${parsed?.summary ?? ""}`]);
  if (commit.code !== 0) {
    await update(job.id, { status: "failed", error: "git commit failed", log_tail: (commit.out + commit.err).slice(-2000) });
    return;
  }
  const push = sh("git", ["push", "-u", "origin", branch!]);
  if (push.code !== 0) {
    await update(job.id, { status: "failed", error: "git push failed", log_tail: push.err.slice(-2000) });
    return;
  }
  const pr = await ensurePr(branch!, slug, false);
  if (!pr) {
    await update(job.id, { status: "needs_attention", error: "branch pushed but PR creation failed", log_tail: logTail });
    return;
  }
  await update(job.id, { status: "completed", pr_url: pr.url, pr_number: pr.number, log_tail: logTail });
  console.log(`${tag} ✓ completed → ${pr.url}`);
}

async function main() {
  if (!GH_TOKEN) throw new Error("GITHUB_TOKEN not set");
  db = await admin();
  ensureGitIdentity();
  console.log(`builder-worker up — repo ${REPO} at ${REPO_DIR}, polling every ${POLL_MS}ms`);
  for (;;) {
    try {
      const { data } = await db.rpc("claim_agent_job");
      const job = (Array.isArray(data) ? data[0] : data) as Job | null;
      if (job && job.id) {
        try {
          await runJob(job);
        } catch (e) {
          console.error(`[${job.spec_slug}] failed:`, e);
          await update(job.id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      console.error("poll error:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
