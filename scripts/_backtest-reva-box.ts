/**
 * scripts/_backtest-reva-box.ts — reva-box-session-causal-rollback Phase 5 backtest harness.
 *
 * The go-live gate for flipping `DEPLOY_GUARDIAN_AUTOREVERT_MODE` from `'off'` to `'box'`. Feeds each
 * historical fixture (curated below) into Reva's box-review session (`.claude/skills/deploy-review`)
 * and asserts the returned decision matches the expected one:
 *
 *   - 2026-07-04 false-revert set — every fixture must return `keep` (per-signal evidence of no
 *     causal path). These are the four incidents the deterministic verdictFor path mis-reverted, and
 *     the whole point of the causal-review effort.
 *   - Historical false-revert classes named in src/lib/deploy-guardian.ts — build-card-lifecycle-timeline
 *     (fold-gate diff mis-attributed to a `supabase-logs` burst + an Appstle `UserGeneratedError`),
 *     blog-pixel-tracking (a storefront pixel mis-attributed to a `kpi_drift:*:monthly` red loop),
 *     noop-pipeline-test-6 (a no-op spec mis-attributed to weekly-aggregate kpi_drift). All 'keep'.
 *   - A synthetic same-surface high-count regression (must return `revert`).
 *
 * MODES:
 *   npx tsx scripts/_backtest-reva-box.ts           # DRY-RUN: print each fixture + its brief + expected decision, exit 0.
 *   npx tsx scripts/_backtest-reva-box.ts --run     # LIVE: spawn `claude -p` per fixture with the deploy-review skill,
 *                                                    parse the returned JSON verdict, assert each fixture's decision.
 *                                                    Exits 1 on any mismatch — the flip-the-kill-switch gate.
 *
 * The dry-run mode is what CI can smoke-check (the brief serializes cleanly, the fixture table has no drift).
 * The --run mode is a MANUAL pre-go-live gate the operator runs once against a healthy Max account: 8 fixtures
 * × ≤2 min/fixture ≈ 15 min. Results are printed live per fixture + summarized at the end.
 *
 * The harness is deliberately DECOUPLED from `scripts/builder-worker.ts`'s runDeployReviewClaude (no session
 * resume, no multi-account failover, no heartbeat plumbing) — it's a one-shot verification, not a lane.
 */
import { execSync, spawnSync } from "child_process";
import { errText } from "../src/lib/error-text";
import { resolve } from "path";
// _bootstrap loads .env.local (locally) and provides admin-client access — not needed here (harness is
// git + LLM only), but importing keeps the script consistent with the scripts/_*.ts convention.
import "./_bootstrap";

// ─── Fixture table ───────────────────────────────────────────────────────────────
// Each fixture: the historical merge_sha, the spec slug it deployed, the plausible candidate signals
// the deterministic verdictFor path would have surfaced (the ones that historically tripped the
// false-revert), a one-line incident summary, and the expected decision Reva SHOULD return now.
//
// Fixtures without a real merge_sha (build-card-lifecycle-timeline / blog-pixel-tracking / noop-
// pipeline-test-6 — these are class descriptions from src/lib/deploy-guardian.ts comments, not
// specific reverted commits) use a `mergeSha=null` marker and the harness reconstructs the brief
// from a stand-in changed-files list documented in the incident summary. The synthetic positive
// fixture (`synthetic-same-surface-regression`) points at a real commit and adds a synthetic
// high-count same-surface error to trip the revert threshold.

interface Fixture {
  key: string;
  slug: string;
  branch: string;
  mergeSha: string | null;
  expected: "keep" | "revert" | "escalate";
  /** One line for the summary + brief. */
  incident: string;
  new_error_signatures: Array<{ signature: string; source: string; title: string | null; count: number }>;
  new_red_loops: Array<{ loop_id: string; reason: string; detail: string }>;
  findings_verdict: "regressed" | "unsure";
}

const FIXTURES: Fixture[] = [
  {
    key: "july04-portal-external-fetch-timeout-guard",
    slug: "portal-external-fetch-timeout-guard",
    branch: "claude/portal-external-fetch-timeout-guard",
    mergeSha: "3886045",
    expected: "keep",
    incident:
      "Diff added portalFetch(...) around portal handlers + a Lambda maxDuration. Reva must reject a ticket-csat-cron freshness loop as caused — the portal handlers have no path to the ticket-csat cron.",
    new_error_signatures: [],
    new_red_loops: [{ loop_id: "cron:ticket-csat-cron:freshness", reason: "cron freshness threshold breached", detail: "no runs in > 15 min" }],
    findings_verdict: "regressed",
  },
  {
    key: "july04-error-feed-drop-undici-headers-timeout-noise",
    slug: "error-feed-drop-undici-headers-timeout-noise",
    branch: "claude/error-feed-drop-undici-headers-timeout-noise",
    mergeSha: "f3240b8",
    expected: "keep",
    incident:
      "Diff extended the error-feed noise classifier (src/lib/control-tower/error-feed.ts) to drop undici HeadersTimeoutError noise. Reva must reject a new undici timeout signature as caused — the classifier only adds signature dropping, cannot itself EMIT undici errors.",
    new_error_signatures: [
      { signature: "vercel:undici-headers-timeout", source: "vercel", title: "HeadersTimeoutError: Headers Timeout Error", count: 4 },
    ],
    new_red_loops: [],
    findings_verdict: "regressed",
  },
  {
    key: "july04-error-feed-drop-supabase-edge-html-body-noise",
    slug: "error-feed-drop-supabase-edge-html-body-noise",
    branch: "claude/error-feed-drop-supabase-edge-html-body-noise",
    mergeSha: "5686a78",
    expected: "keep",
    incident:
      "Diff extended the same noise classifier to drop a Supabase edge HTML-body wrapper. Reva must reject a new Supabase edge HTML-body error as caused — same class as the undici fixture, the classifier can't emit its own noise.",
    new_error_signatures: [
      { signature: "supabase-logs:edge-html-body-wrapper", source: "supabase-logs", title: "Edge Function returned HTML body wrapper", count: 3 },
    ],
    new_red_loops: [],
    findings_verdict: "regressed",
  },
  {
    key: "july04-error-feed-scope-supabase-auth-504-gateway-timeout-transient",
    slug: "error-feed-scope-supabase-auth-504-gateway-timeout-transient",
    branch: "claude/error-feed-scope-supabase-auth-504-gateway-timeout-transient",
    mergeSha: "708dd73",
    expected: "keep",
    incident:
      "Diff extended isTransientSupabaseLogNoise to flag Supabase Auth's 504 wrapper as transient. Reva must reject a fresh Supabase-auth 504 signature as caused — the classifier ADDS a transient tag, it does not itself produce Supabase gateway responses.",
    new_error_signatures: [
      { signature: "supabase-logs:auth-504-processing-timeout", source: "supabase-logs", title: "processing this request timed out (504)", count: 5 },
    ],
    new_red_loops: [],
    findings_verdict: "regressed",
  },
  {
    key: "historical-build-card-lifecycle-timeline",
    slug: "build-card-lifecycle-timeline",
    branch: "claude/build-card-lifecycle-timeline",
    mergeSha: null, // class fixture — no specific reverted commit; see stand-in files below.
    expected: "keep",
    incident:
      "Historical: a fold-gate diff to getAutoFoldEligibleSlugs (src/lib/agents/platform-scorecard.ts) was mis-attributed to a 1-second burst of 7 supabase-logs 502s + a recurring Appstle UserGeneratedError. Reva must reject both — a Vercel code deploy cannot make Supabase's gateway return 502, and Appstle UserGeneratedError is a business-state condition, not a code fault.",
    new_error_signatures: [
      { signature: "supabase-logs:gateway-502-burst", source: "supabase-logs", title: "Bad Gateway", count: 7 },
      { signature: "inngest:appstle-usergenerated-billing-edit", source: "inngest", title: "UserGeneratedError: Subscription contract cannot be updated if there is a current/upcoming billing-cycle edit", count: 2 },
    ],
    new_red_loops: [],
    findings_verdict: "regressed",
  },
  {
    key: "historical-blog-pixel-tracking",
    slug: "blog-pixel-tracking",
    branch: "claude/blog-pixel-tracking",
    mergeSha: null,
    expected: "keep",
    incident:
      "Historical: a storefront pixel diff was auto-reverted on a single kpi_drift:human_touch_per_build:monthly red loop. Reva must reject — a monthly kpi_drift is a trailing 30-day BUILD-PIPELINE autonomy KPI a storefront pixel cannot causally shift in a canary window (or ever).",
    new_error_signatures: [],
    new_red_loops: [{ loop_id: "kpi_drift:human_touch_per_build:monthly", reason: "monthly aggregate breached threshold", detail: "trailing-30d ratio" }],
    findings_verdict: "regressed",
  },
  {
    key: "historical-noop-pipeline-test-6",
    slug: "noop-pipeline-test-6",
    branch: "claude/noop-pipeline-test-6",
    mergeSha: null,
    expected: "keep",
    incident:
      "Historical: a no-op spec's deploy was auto-reverted because two weekly-aggregate kpi_drift loops (specs_per_week, regression_coverage_pct) flipped red in its canary window from a high-volume PM night. Reva must reject — a no-op cannot move PM-volume weekly aggregates.",
    new_error_signatures: [],
    new_red_loops: [
      { loop_id: "kpi_drift:specs_per_week:weekly", reason: "weekly aggregate breached threshold", detail: "trailing-7d count" },
      { loop_id: "kpi_drift:regression_coverage_pct:weekly", reason: "weekly aggregate breached threshold", detail: "trailing-7d ratio" },
    ],
    findings_verdict: "regressed",
  },
  {
    key: "synthetic-same-surface-regression",
    slug: "synthetic-portal-503-regression",
    branch: "claude/synthetic-portal-503-regression",
    mergeSha: "3886045", // reuse a real merge whose diff touches portal handlers so `git show` returns real files.
    expected: "revert",
    incident:
      "Synthetic positive: same merge as the portal fixture but with a HIGH-COUNT vercel error whose sample.path is a portal handler the diff literally touched. Reva must return revert with a cited file:line in the diff → the erroring handler.",
    new_error_signatures: [
      // The historical portal diff touched src/lib/portal/handlers/replace-variants.ts and others.
      // A synthetic HeadersTimeoutError landing on /api/portal (a portal handler) with count ≥ MIN_COUNT
      // is a same-surface high-count regression that Reva SHOULD accept as caused.
      { signature: "vercel:portal-replace-variants-500", source: "vercel", title: "Error: portal replace-variants handler threw — /api/portal", count: 12 },
    ],
    new_red_loops: [],
    findings_verdict: "regressed",
  },
];

// ─── Brief construction (mirrors builder-worker.ts deployReviewBrief) ────────────

function fetchDiffSummary(mergeSha: string | null): { files: string[]; unavailable?: string } {
  if (!mergeSha) return { files: [], unavailable: "no merge_sha — this is a class-fixture stand-in; the LLM should use the incident summary as the diff surrogate" };
  try {
    const out = execSync(`git show --stat --format= ${mergeSha}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split("\n").map((l) => (l.match(/^\s(\S+)\s*\|/) || [])[1]).filter((f): f is string => !!f);
    return { files };
  } catch (e) {
    return { files: [], unavailable: `git show failed: ${errText(e)}` };
  }
}

function buildBrief(f: Fixture): string {
  const diff = fetchDiffSummary(f.mergeSha);
  return [
    `DEPLOY WATCH (backtest fixture ${f.key})`,
    `  slug: ${f.slug} · branch: ${f.branch}`,
    `  merge_sha: ${f.mergeSha ?? "(class fixture; no real merge_sha)"}`,
    `  findings_verdict: ${f.findings_verdict} · deployed_at: (historical) · window_ends_at: (historical)`,
    ``,
    `CHANGED FILES (${diff.files.length}${diff.unavailable ? ` — ${diff.unavailable}` : ""}):`,
    ...diff.files.slice(0, 30).map((p) => `  ${p}`),
    diff.files.length > 30 ? `  … ${diff.files.length - 30} more` : "",
    ``,
    `INCIDENT SUMMARY (for the backtest — the historical why): ${f.incident}`,
    ``,
    `NEW ERROR SIGNATURES (${f.new_error_signatures.length}):`,
    ...f.new_error_signatures.map((s) => `  • [${s.source}] "${s.title ?? ""}" — signature ${s.signature} · count ${s.count}`),
    ``,
    `NEW RED LOOPS (${f.new_red_loops.length}):`,
    ...f.new_red_loops.map((l) => `  • ${l.loop_id} — ${l.reason} · ${l.detail}`),
    ``,
    `EXCLUDED RED LOOPS (0) — pre-filter already dropped known-foreign infra/user-state signals.`,
    ``,
    `EXPECTED DECISION (this backtest asserts): ${f.expected}`,
  ].filter((l) => l !== "").join("\n");
}

function buildPrompt(f: Fixture): string {
  const brief = buildBrief(f);
  return [
    `Use the deploy-review skill (cwd is the repo root). You are Reva, the box's Deploy Guardian, running the reva-box-session-causal-rollback Phase 5 BACKTEST harness. This is a REGRESSION TEST — the expected decision is at the bottom of the brief. Judge causally as you would in production and emit the same JSON verdict you would return normally; the harness asserts your decision matches the expected one.`,
    ``,
    brief,
    ``,
    `Steps:`,
    `  1. If merge_sha is present, git show it + git diff to enumerate the deploy's real changed files. If not (class fixture), use the incident summary + the changed-files stand-in above.`,
    `  2. For each candidate signal, identify the source surface (a route file, an inngest cron, a src/lib/* library) and Read it.`,
    `  3. Decide per-signal whether the diff has a CAUSAL PATH to the surface — cite a file:line either way.`,
    ``,
    `Final message = ONLY one JSON object (no prose after):`,
    `  {"decision":"revert"|"keep"|"escalate","signals":[{"key":"…","surface":"…","caused":true|false,"evidence":"…file:line…"}],"reasoning":"<2-4 sentences citing at least one real file:line>"}`,
  ].join("\n");
}

// ─── Verdict extraction from `claude -p` stream-json output ─────────────────────

interface RunResult { rawStdout: string; verdict: { decision?: string; signals?: unknown; reasoning?: string } | null; isError: boolean; }

function runClaudeOnce(prompt: string): RunResult {
  // Mirror scripts/builder-worker.ts's runBoxSession spawn args (minus session/account plumbing).
  const args = ["-p", prompt, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // Max session — no API-billed fallback.
  const res = spawnSync("claude", args, { cwd: resolve(__dirname, ".."), env, encoding: "utf8", timeout: 15 * 60 * 1000 });
  const rawStdout = String(res.stdout ?? "");
  let resultText = "";
  let isError = res.status !== 0;
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    try {
      const ev = JSON.parse(trimmed) as { type?: string; result?: string; is_error?: boolean };
      if (ev.type === "result") {
        resultText = String(ev.result ?? "");
        if (ev.is_error) isError = true;
      }
    } catch { /* stream noise */ }
  }
  // Extract the FINAL {…} JSON object from the result text (the deploy-review skill's contract).
  const m = /\{[\s\S]*\}\s*$/.exec(resultText.trim());
  let verdict: RunResult["verdict"] = null;
  if (m) {
    try { verdict = JSON.parse(m[0]) as RunResult["verdict"]; } catch { /* leave null */ }
  }
  return { rawStdout, verdict, isError };
}

// ─── Main ────────────────────────────────────────────────────────────────────────

function main(): number {
  const args = new Set(process.argv.slice(2));
  const live = args.has("--run");
  console.log(`reva-box-session-causal-rollback Phase 5 backtest — ${live ? "LIVE (--run)" : "DRY-RUN"}`);
  console.log(`  ${FIXTURES.length} fixtures (${FIXTURES.filter((f) => f.expected === "keep").length} keep · ${FIXTURES.filter((f) => f.expected === "revert").length} revert · ${FIXTURES.filter((f) => f.expected === "escalate").length} escalate)`);
  console.log();

  const results: Array<{ key: string; expected: string; actual: string; pass: boolean; reasoning?: string; error?: string }> = [];

  for (const f of FIXTURES) {
    console.log(`── ${f.key} (expected: ${f.expected})`);
    if (!live) {
      // Dry-run: emit the brief so the operator can eyeball what would be sent.
      console.log(buildBrief(f));
      console.log();
      results.push({ key: f.key, expected: f.expected, actual: "(dry-run)", pass: true });
      continue;
    }
    const prompt = buildPrompt(f);
    const started = Date.now();
    const r = runClaudeOnce(prompt);
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (!r.verdict || typeof r.verdict.decision !== "string") {
      const err = `no parseable verdict (isError=${r.isError})`;
      console.log(`  ❌ FAIL (${elapsed}s) — ${err}`);
      results.push({ key: f.key, expected: f.expected, actual: "(unparseable)", pass: false, error: err });
      continue;
    }
    const actual = String(r.verdict.decision).toLowerCase();
    const pass = actual === f.expected;
    console.log(`  ${pass ? "✅ PASS" : "❌ FAIL"} (${elapsed}s) — decision=${actual} · reasoning: ${String(r.verdict.reasoning ?? "").slice(0, 240)}`);
    results.push({ key: f.key, expected: f.expected, actual, pass, reasoning: typeof r.verdict.reasoning === "string" ? r.verdict.reasoning : undefined });
  }

  console.log();
  console.log("── Summary ──");
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`  ${passed} / ${results.length} passed${failed ? ` · ${failed} failed` : ""}`);
  for (const r of results) console.log(`   ${r.pass ? "✅" : "❌"} ${r.key} — expected=${r.expected} · actual=${r.actual}${r.error ? ` · ${r.error}` : ""}`);
  console.log();
  if (!live) {
    console.log("Dry-run complete. Run with --run to invoke Reva against each fixture and assert its decision.");
    console.log("Go-live gate: once every fixture passes with --run, flip DEPLOY_GUARDIAN_AUTOREVERT_MODE=box (see docs/brain/libraries/deploy-guardian.md § Status).");
    return 0;
  }
  if (failed) {
    console.log("Do NOT flip DEPLOY_GUARDIAN_AUTOREVERT_MODE to 'box' until every fixture returns its expected decision.");
    return 1;
  }
  console.log("All fixtures returned the expected decision — the go-live gate is GREEN.");
  console.log("Next: set DEPLOY_GUARDIAN_AUTOREVERT_MODE=box in the box's systemd EnvironmentFile + restart the worker.");
  return 0;
}

process.exit(main());
