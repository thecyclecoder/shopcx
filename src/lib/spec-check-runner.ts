/**
 * spec-check-runner — deterministic Node runner over machine-declared verification checks
 * (machine-declared-verification-and-deterministic-spec-test-runner Phase 2).
 *
 * Reads a spec's [[spec-phase-checks-table]] rows and, per auto-testable `exec_kind`, EXECUTES the
 * real check as plain code — instant, free, flake-free, and non-destructive by construction. Emits
 * `{ text, checkKey, verdict: 'pass'|'fail'|'needs_human', category, evidence, exec_kind }` per row —
 * the same [[spec-test-runs]] SpecTestCheck shape the LLM spec-test agent writes to `spec_test_runs`
 * today, so Phase 3 can drop the runner's output straight into a run + fold on it.
 *
 * The four Phase-2 invariants (see docs/brain/libraries/spec-check-runner.md):
 *   1. NO LLM CALL — the runner is a plain module; if you can grep the source for `anthropic` you
 *      will find nothing here.
 *   2. NON-DESTRUCTIVE — only kinds in `AUTO_TESTABLE_EXEC_KINDS` execute; anything else
 *      (mutating sql, undeclared prose, unknown script, invalid params) resolves to `needs_human`.
 *   3. HARNESS ERROR ≠ FAIL — a command that didn't RUN (ENOENT / missing script / command-not-found)
 *      is a broken bullet, not a code regression. [[spec-test-harness-classifier]]
 *      `isHarnessCommandFailure` re-routes any such `fail` to `needs_human` with the harness evidence
 *      preserved — the exact 2026-07-11 cs-director class the spec cites in § Why.
 *   4. DETERMINISTIC — same input rows + same injected executors → byte-identical results (there is
 *      no random id, no wall-clock timestamp inside a per-check result).
 *
 * DI is a first-class concern: `deps.loadChecks` + `deps.executors` are both injectable so unit tests
 * drive the policy without touching shell/DB/network. The default executors (Phase 2 wiring) call the
 * real tools (npx tsc, ripgrep, gh, fetch, pooled admin client, npm run, next build); Phase 3 (Vera)
 * imports the runner + defaults from here without change.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  AUTO_TESTABLE_EXEC_KINDS,
  validateExecutableCheck,
  type SpecPhaseCheckExecKind,
  type SpecPhaseCheckParams,
  type GrepCheckParams,
  type HttpGetCheckParams,
  type DbProbeReadonlyCheckParams,
  type UnitTestCheckParams,
} from "@/lib/spec-phase-checks-table";
import { isHarnessCommandFailure } from "@/lib/spec-test-harness-classifier";
import { checkKey } from "@/lib/spec-test-runs";

/**
 * The trimmed row shape the runner consumes — a superset of `spec_phase_checks` picked so tests can
 * hand-author fixtures without importing the DB types. `params` is the same jsonb the validator
 * enforces; a null/needs_human/undeclared row falls through to needs_human.
 */
export interface LoadedCheck {
  text: string;
  exec_kind: SpecPhaseCheckExecKind | null;
  params: SpecPhaseCheckParams;
}

export type CheckVerdict = "pass" | "fail" | "needs_human";
export type CheckCategory = "auto" | "needs_human";

export interface CheckResult {
  /** The check's description (source of `checkKey`, matches [[spec-test-runs]] `SpecTestCheck.text`). */
  text: string;
  /** Stable hash of the description via [[spec-test-runs]] `checkKey` — survives re-runs. */
  checkKey: string;
  verdict: CheckVerdict;
  category: CheckCategory;
  evidence: string;
  /** The declared exec_kind (echoed so Phase 3's writeback can distinguish auto vs residual). */
  exec_kind: SpecPhaseCheckExecKind | null;
}

export interface RunSpecChecksResult {
  workspaceId: string;
  slug: string;
  results: CheckResult[];
}

/**
 * Each executor is a pure `(input) → Promise<{ ok, evidence }>` — the runner turns `ok` into
 * `verdict` + adds the harness-error downgrade. Injecting them keeps the runner unit-testable and
 * makes Phase 3's wiring (LLM residual on top) additive.
 */
export interface ExecutorResult {
  ok: boolean;
  evidence: string;
}
export interface CheckExecutors {
  tsc: (ctx: { repoRoot: string }) => Promise<ExecutorResult>;
  grep: (ctx: { repoRoot: string; params: GrepCheckParams }) => Promise<ExecutorResult>;
  ci_status: (ctx: { repoRoot: string }) => Promise<ExecutorResult>;
  http_get: (ctx: { params: HttpGetCheckParams }) => Promise<ExecutorResult>;
  db_probe_readonly: (ctx: { params: DbProbeReadonlyCheckParams }) => Promise<ExecutorResult>;
  unit_test: (ctx: { repoRoot: string; params: UnitTestCheckParams }) => Promise<ExecutorResult>;
  build: (ctx: { repoRoot: string }) => Promise<ExecutorResult>;
}

export interface RunSpecChecksDeps {
  loadChecks: (workspaceId: string, slug: string) => Promise<LoadedCheck[]>;
  executors: CheckExecutors;
  packageScripts?: ReadonlySet<string>;
  repoRoot?: string;
}

export interface RunSpecChecksInput {
  workspaceId: string;
  slug: string;
  deps: RunSpecChecksDeps;
}

/**
 * Runs every check for a spec and returns per-row verdicts + evidence — no LLM anywhere on this path.
 * Sequential by design (deterministic order = deterministic evidence) and cheap: the checks a spec has
 * are typically <10, and each executor is O(seconds) at worst.
 */
export async function runSpecChecks(input: RunSpecChecksInput): Promise<RunSpecChecksResult> {
  const { workspaceId, slug, deps } = input;
  const rows = await deps.loadChecks(workspaceId, slug);
  const results: CheckResult[] = [];
  for (const row of rows) {
    results.push(await runOneCheck(row, deps));
  }
  return { workspaceId, slug, results };
}

async function runOneCheck(row: LoadedCheck, deps: RunSpecChecksDeps): Promise<CheckResult> {
  const key = checkKey(row.text);
  const base = { text: row.text, checkKey: key, exec_kind: row.exec_kind } as const;
  const kind = row.exec_kind;

  // Undeclared / prose / explicit needs_human — the safe-default rail. Nothing auto-runs, ever.
  if (!kind || kind === "needs_human") {
    return {
      ...base,
      verdict: "needs_human",
      category: "needs_human",
      evidence: !kind
        ? "no executable payload (exec_kind is null — undeclared prose)"
        : "declared needs_human — subjective / drift / owner-verified",
    };
  }

  // App-layer schema gate. Includes the mutating-SQL guard for db_probe_readonly and the
  // package.json-script existence check for unit_test (packageScripts passed via deps).
  const validation = validateExecutableCheck(
    { exec_kind: kind, params: row.params },
    { packageScripts: deps.packageScripts },
  );
  if (!validation.valid) {
    return {
      ...base,
      verdict: "needs_human",
      category: "needs_human",
      evidence: `validator rejected: ${validation.reason}`,
    };
  }

  // A check the runner does not know how to execute (defensive — the validator covers this, but a
  // future new kind added before its executor lands falls through cleanly).
  if (!(AUTO_TESTABLE_EXEC_KINDS as readonly SpecPhaseCheckExecKind[]).includes(kind)) {
    return {
      ...base,
      verdict: "needs_human",
      category: "needs_human",
      evidence: `no executor for exec_kind '${kind}'`,
    };
  }

  const repoRoot = deps.repoRoot ?? process.cwd();
  let executed: ExecutorResult;
  try {
    executed = await dispatchExecutor(kind, row.params, deps.executors, repoRoot);
  } catch (e) {
    // A thrown executor is a HARNESS error too (spawn failure, network unreachable, DB blip) — not
    // an assertion `fail`. Preserving the raw message keeps the harness signature matchable.
    const msg = (e as Error).message ?? String(e);
    executed = { ok: false, evidence: `executor error: ${msg}` };
  }

  // The 2026-07-11 durable rule — if the evidence carries a harness signature, this check never
  // actually ran an assertion. Downgrade a would-be fail to needs_human with the evidence intact so
  // the residual LLM pass (or the owner) sees why.
  if (isHarnessCommandFailure(executed.evidence)) {
    return {
      ...base,
      verdict: "needs_human",
      category: "needs_human",
      evidence: `harness error (bullet broken, not code): ${executed.evidence}`,
    };
  }

  return {
    ...base,
    verdict: executed.ok ? "pass" : "fail",
    category: "auto",
    evidence: executed.evidence,
  };
}

async function dispatchExecutor(
  kind: SpecPhaseCheckExecKind,
  params: SpecPhaseCheckParams,
  executors: CheckExecutors,
  repoRoot: string,
): Promise<ExecutorResult> {
  switch (kind) {
    case "tsc":
      return executors.tsc({ repoRoot });
    case "build":
      return executors.build({ repoRoot });
    case "ci_status":
      return executors.ci_status({ repoRoot });
    case "grep":
      return executors.grep({ repoRoot, params: params as GrepCheckParams });
    case "http_get":
      return executors.http_get({ params: params as HttpGetCheckParams });
    case "db_probe_readonly":
      return executors.db_probe_readonly({ params: params as DbProbeReadonlyCheckParams });
    case "unit_test":
      return executors.unit_test({ repoRoot, params: params as UnitTestCheckParams });
    case "needs_human":
      // Unreachable: `runOneCheck` handles needs_human before dispatch. Kept exhaustive so an added
      // enum member trips the compiler.
      return { ok: false, evidence: "needs_human — never executed" };
    default: {
      const never: never = kind;
      return { ok: false, evidence: `unknown exec_kind: ${String(never)}` };
    }
  }
}

// ── Default executors ────────────────────────────────────────────────────────────────────────────
//
// Real-tool wiring used by Phase 3 (`runSpecTestJob`). Each spawns the corresponding command with a
// bounded output buffer so an over-verbose check can't OOM the worker. Failures include the raw
// stderr — the harness classifier reads it to decide whether this is a real fail or a broken bullet.

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

async function runCmd(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", error: (e as Error).message });
      return;
    }
    const kill = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* noop */ }
    }, timeoutMs);
    child.stdout?.on("data", (d) => { stdout += d.toString(); if (stdout.length > 200_000) stdout = stdout.slice(-200_000); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
    child.on("error", (e) => {
      clearTimeout(kill);
      resolve({ code: null, stdout, stderr, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ code, stdout, stderr });
    });
  });
}

export const defaultExecutors: CheckExecutors = {
  tsc: async ({ repoRoot }) => {
    const r = await runCmd("npx", ["tsc", "--noEmit"], repoRoot);
    if (r.error) return { ok: false, evidence: `spawn error: ${r.error}` };
    return { ok: r.code === 0, evidence: r.code === 0 ? "npx tsc --noEmit — clean" : (r.stderr || r.stdout || `exit ${r.code}`).slice(0, 4000) };
  },
  grep: async ({ repoRoot, params }) => {
    const args = ["--no-heading", "-n"];
    if (params.path) args.push(params.path);
    args.push(params.pattern);
    const r = await runCmd("rg", ["-e", params.pattern, params.path ?? "."], repoRoot);
    if (r.error) return { ok: false, evidence: `spawn rg: ${r.error}` };
    // rg exits 0 on match, 1 on no match. Anything else = harness error (bad flag, invalid regex).
    if (r.code !== 0 && r.code !== 1) {
      return { ok: false, evidence: (r.stderr || r.stdout || `rg exit ${r.code}`).slice(0, 4000) };
    }
    const found = r.code === 0;
    const ok = params.expect === "present" ? found : !found;
    return {
      ok,
      evidence: `ripgrep '${params.pattern}' ${params.path ?? "."} — ${found ? "match(es) found" : "no match"} (expect=${params.expect})`,
    };
  },
  ci_status: async ({ repoRoot }) => {
    const r = await runCmd("gh", ["pr", "checks"], repoRoot);
    if (r.error) return { ok: false, evidence: `spawn gh: ${r.error}` };
    return {
      ok: r.code === 0,
      evidence: `gh pr checks — ${r.code === 0 ? "green" : `exit ${r.code}`}\n${(r.stdout || r.stderr).slice(0, 2000)}`,
    };
  },
  http_get: async ({ params }) => {
    try {
      const res = await fetch(params.url, { redirect: "manual" });
      return {
        ok: res.status === params.expect_status,
        evidence: `GET ${params.url} → ${res.status} (expect ${params.expect_status})`,
      };
    } catch (e) {
      return { ok: false, evidence: `fetch error: ${(e as Error).message}` };
    }
  },
  db_probe_readonly: async ({ params }) => {
    // Belt: the validator already asserted `sql` is a plain SELECT/WITH. Suspenders: assert once
    // more here so a caller that skipped the validator can't sneak a mutating statement through.
    const { isPlainReadonlySql } = await import("@/lib/spec-phase-checks-table");
    if (!isPlainReadonlySql(params.sql)) {
      return { ok: false, evidence: "runner refused: sql is not a plain read-only SELECT" };
    }
    try {
      const { createAdminClient } = await import("@/lib/supabase/admin");
      const admin = createAdminClient();
      // Route through the workspace-scoped RPC if available; otherwise a raw admin query. Kept
      // dynamic so the module works in test contexts that stub the admin client.
      const { data, error } = await (admin as unknown as {
        rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
      }).rpc("exec_readonly_sql", { sql_text: params.sql });
      if (error) return { ok: false, evidence: `db probe error: ${(error as { message?: string }).message ?? String(error)}` };
      const matches = JSON.stringify(data) === JSON.stringify(params.expect);
      return {
        ok: matches,
        evidence: matches
          ? `probe matched expect (${JSON.stringify(params.expect).slice(0, 400)})`
          : `probe returned ${JSON.stringify(data).slice(0, 400)} (expect ${JSON.stringify(params.expect).slice(0, 400)})`,
      };
    } catch (e) {
      return { ok: false, evidence: `db probe error: ${(e as Error).message}` };
    }
  },
  unit_test: async ({ repoRoot, params }) => {
    // The validator (with `packageScripts`) already rejected a script name absent from package.json;
    // the runner still guards here for the case where packageScripts wasn't provided (Phase 2's
    // caller may not know the set yet; Phase 3 loads + passes it).
    try {
      const pkg = JSON.parse(readFileSync(resolvePath(repoRoot, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      if (!Object.prototype.hasOwnProperty.call(scripts, params.script)) {
        // Emit a harness-classifier-matching signature so the runner's downgrade path picks it up.
        return { ok: false, evidence: `npm error Missing script: "${params.script}"` };
      }
    } catch (e) {
      return { ok: false, evidence: `package.json read error: ${(e as Error).message}` };
    }
    const r = await runCmd("npm", ["run", params.script], repoRoot);
    if (r.error) return { ok: false, evidence: `spawn npm: ${r.error}` };
    return {
      ok: r.code === 0,
      evidence: r.code === 0
        ? `npm run ${params.script} — exit 0`
        : (r.stderr || r.stdout || `npm run ${params.script} — exit ${r.code}`).slice(0, 4000),
    };
  },
  build: async ({ repoRoot }) => {
    const r = await runCmd("npx", ["next", "build"], repoRoot);
    if (r.error) return { ok: false, evidence: `spawn error: ${r.error}` };
    return {
      ok: r.code === 0,
      evidence: r.code === 0
        ? "next build — exit 0"
        : (r.stderr || r.stdout || `next build — exit ${r.code}`).slice(0, 4000),
    };
  },
};

/**
 * DB row loader used by Phase 3's Vera lane wiring. Reads every phase's checks for a spec in one
 * batched select, then interleaves them in phase order (same order the LLM lane sees today, so the
 * checkKey→verdict mapping stays stable).
 */
export async function defaultLoadChecks(workspaceId: string, slug: string): Promise<LoadedCheck[]> {
  const { getSpec } = await import("@/lib/specs-table");
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const spec = await getSpec(workspaceId, slug);
  if (!spec) return [];
  const phaseIds = spec.phases.map((p) => p.id).filter(Boolean);
  if (!phaseIds.length) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("spec_phase_checks")
    .select("phase_id, position, description, exec_kind, params")
    .in("phase_id", phaseIds)
    .order("position", { ascending: true });
  if (error) throw error;
  const byPhase = new Map<string, LoadedCheck[]>();
  for (const r of (data ?? []) as Array<{
    phase_id: string;
    position: number;
    description: string;
    exec_kind: SpecPhaseCheckExecKind | null;
    params: SpecPhaseCheckParams;
  }>) {
    const list = byPhase.get(r.phase_id) ?? [];
    list.push({ text: r.description, exec_kind: r.exec_kind, params: r.params });
    byPhase.set(r.phase_id, list);
  }
  const out: LoadedCheck[] = [];
  for (const p of [...spec.phases].sort((a, b) => a.position - b.position)) {
    for (const c of byPhase.get(p.id) ?? []) out.push(c);
  }
  return out;
}
