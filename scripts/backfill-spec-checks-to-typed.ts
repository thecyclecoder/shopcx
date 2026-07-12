/**
 * backfill-spec-checks-to-typed — every-spec-writer-authors-machine-runnable-verifications Phase 3.
 *
 * Best-effort backfill: sweep every `public.spec_phase_checks` row with `exec_kind='needs_human'`
 * (the safe default `parseVerificationBlobToChecks` stamps on un-typed prose bullets) and rewrite
 * the exec_kind + params to a TYPED machine-runnable shape when the description prose is
 * UNAMBIGUOUSLY derivable (tsc / build / ci_status / http_get / unit_test with a real
 * package.json script). Anything else stays `needs_human` — the safe direction (nothing auto-runs
 * on prose we can't confidently type). db_probe_readonly + grep are DELIBERATELY not auto-derived
 * (fabrication risk — probe_id must come from a registered allowlist; a grep pattern extracted
 * from prose isn't literal enough to run safely against ripgrep).
 *
 * The Phase 1 chokepoint gate now REQUIRES ≥1 machine-runnable check per phase at author time, so
 * this backfill promotes as many phases as possible to "already satisfies the invariant" without
 * inventing false claims.
 *
 * Two-phase (mirrors [[backfill-spec-timecards-from-history]] shape):
 *   npx tsx scripts/backfill-spec-checks-to-typed.ts             # dry-run manifest (default)
 *   npx tsx scripts/backfill-spec-checks-to-typed.ts --apply     # write
 *   npx tsx scripts/backfill-spec-checks-to-typed.ts --workspace=<uuid> [--apply]
 *
 * Idempotent — a re-run only touches rows still at exec_kind='needs_human'; the safe-direction
 * classifier is pure so identical descriptions map identically across runs.
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { createAdminClient } from "./_bootstrap";

type Admin = ReturnType<typeof createAdminClient>;

const PAGE = 1000;

// ── ExecKind + validated params (mirrors src/lib/spec-phase-checks-table.ts) ─────────────────────
export type ExecKind =
  | "tsc"
  | "grep"
  | "ci_status"
  | "http_get"
  | "db_probe_readonly"
  | "unit_test"
  | "build"
  | "needs_human";

export type ExecutablePayload =
  | { exec_kind: "tsc"; params: null }
  | { exec_kind: "build"; params: null }
  | { exec_kind: "ci_status"; params: null }
  | { exec_kind: "grep"; params: { pattern: string; path?: string; expect: "present" | "absent" } }
  | { exec_kind: "http_get"; params: { url: string; expect_status: number } }
  | { exec_kind: "unit_test"; params: { script: string } }
  | { exec_kind: "needs_human"; params: null };

// ── Pure classifier (exported for tests) ─────────────────────────────────────────────────────────
//
// PROSE → TYPED CHECK. Safety-first: only converts when the pattern is a full literal match and
// there is no ambiguity. Anything else returns `needs_human` (the safe default — the deterministic
// runner never auto-runs a needs_human row).
//
// Recognized patterns:
//   - "npx tsc --noEmit" / "tsc --noEmit" / "tsc clean"    → tsc, params:null
//   - "npx next build" / "next build" / "npm run build"    → build, params:null
//   - "CI is green" / "all CI checks pass"                  → ci_status, params:null
//   - "npm run <script>" where <script> ∈ packageScripts   → unit_test, {script}
//   - "GET https://…" / "curl https://…" (with optional
//     "returns/expects/status <NNN>", default 200)         → http_get, {url, expect_status}
//
// Grep is DELIBERATELY NOT auto-derived — extracting a safe rg pattern from prose is risky (a
// prose "grep for the new resolver" doesn't literally name the token). Left to the author.
//
// db_probe_readonly is DELIBERATELY NOT auto-derived — the exec_kind requires a registered
// probe_id from src/lib/spec-check-db-probes.ts; matching that against prose fabricates.
export function classifyProseCheck(
  description: string,
  ctx: { packageScripts: ReadonlySet<string> } = { packageScripts: new Set() },
): ExecutablePayload {
  const d = (description ?? "").trim();
  if (!d) return { exec_kind: "needs_human", params: null };
  const dl = d.toLowerCase();

  // tsc — must literally name the tsc command; "typecheck" alone is too vague.
  if (
    /\bnpx\s+tsc\s+--noemit\b/i.test(d) ||
    /\btsc\s+--noemit\b/i.test(d) ||
    /^tsc(\s+(is|passes|clean))?\s*$/i.test(dl) ||
    /\btsc\s+(is\s+)?clean\b/i.test(dl)
  ) {
    return { exec_kind: "tsc", params: null };
  }

  // build — literal `next build` / `npm run build`.
  if (
    /\bnpx\s+next\s+build\b/i.test(d) ||
    /\bnpm\s+run\s+build\b/i.test(d) ||
    /^next\s+build\s*$/i.test(dl) ||
    /\bnext\s+build\s+(is\s+)?clean\b/i.test(dl) ||
    /\bnext\s+build\s+passes\b/i.test(dl)
  ) {
    return { exec_kind: "build", params: null };
  }

  // ci_status — literal "CI is green" / "CI passes".
  if (
    /\b(github\s+)?ci\s+(is\s+)?green\b/i.test(dl) ||
    /\ball\s+ci\s+checks\s+pass\b/i.test(dl) ||
    /\bci\s+(status\s+)?passes\b/i.test(dl)
  ) {
    return { exec_kind: "ci_status", params: null };
  }

  // unit_test — literal `npm run <script>` where the script exists in package.json.
  {
    const m = d.match(/\bnpm\s+run\s+([a-z0-9:_-]+)\b/i);
    if (m) {
      const script = m[1];
      if (ctx.packageScripts.has(script)) {
        return { exec_kind: "unit_test", params: { script } };
      }
    }
  }

  // http_get — a full https?:// URL. If the prose names an integer status (100-599) via
  // "status/returns/responds/expects NNN", use it; otherwise default to 200.
  {
    const um = d.match(/\b(?:GET|curl)\s+(https?:\/\/[^\s"'`)]+)/i);
    if (um) {
      const url = um[1].replace(/[.,;:]+$/, "");
      const statusMatch = d.match(/\b(?:status|returns?|responds?|expect(?:s|ed)?)\s*(?:with\s+)?(\d{3})\b/i);
      const status = statusMatch ? Number(statusMatch[1]) : 200;
      if (Number.isInteger(status) && status >= 100 && status <= 599) {
        return { exec_kind: "http_get", params: { url, expect_status: status } };
      }
    }
  }

  return { exec_kind: "needs_human", params: null };
}

// ── Package.json scripts helper ──────────────────────────────────────────────────────────────────
export function loadPackageScripts(cwd = process.cwd()): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return new Set(Object.keys(pkg.scripts ?? {}));
  } catch {
    return new Set();
  }
}

// ── Backfill mechanics ───────────────────────────────────────────────────────────────────────────

interface CheckRow {
  id: string;
  phase_id: string;
  position: number;
  description: string;
  kind: "auto" | "human";
  exec_kind: ExecKind | null;
  params: unknown;
}

interface ProposedChange {
  id: string;
  phase_id: string;
  position: number;
  description: string;
  from: { exec_kind: ExecKind | null; params: unknown };
  to: ExecutablePayload;
}

async function fetchNeedsHumanRows(admin: Admin, workspaceFilter?: string): Promise<CheckRow[]> {
  const out: CheckRow[] = [];
  // Only rows currently exec_kind='needs_human' — the only ones we ever consider promoting.
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("spec_phase_checks")
      .select("id, phase_id, position, description, kind, exec_kind, params")
      .eq("exec_kind", "needs_human")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`spec_phase_checks read failed: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) out.push(r as CheckRow);
    if (data.length < PAGE) break;
  }
  if (!workspaceFilter) return out;
  // Scope by workspace via phase → spec join (batched to stay under postgrest's array cap).
  const phaseIds = Array.from(new Set(out.map((r) => r.phase_id)));
  const allowed = new Set<string>();
  for (let i = 0; i < phaseIds.length; i += 500) {
    const chunk = phaseIds.slice(i, i + 500);
    const { data, error } = await admin
      .from("spec_phases")
      .select("id, specs!inner(workspace_id)")
      .in("id", chunk)
      .eq("specs.workspace_id", workspaceFilter);
    if (error) throw new Error(`spec_phases read (workspace filter) failed: ${error.message}`);
    for (const p of (data ?? []) as Array<{ id: string }>) allowed.add(String(p.id));
  }
  return out.filter((r) => allowed.has(r.phase_id));
}

async function apply(admin: Admin, changes: ProposedChange[]): Promise<{ ok: number; skipped: number; failed: string[] }> {
  const failed: string[] = [];
  let ok = 0;
  let skipped = 0;
  for (const c of changes) {
    // COMPARE-AND-SET: only rewrite the row IF it is still at exec_kind='needs_human'. This makes
    // a re-run safe (a row already promoted by a prior sweep is skipped) and prevents clobbering
    // a value an author subsequently set through the SDK. `.select("id")` asserts the transition
    // actually happened; a race that raced ahead of us bumps `skipped`, not `failed`.
    const { data, error } = await admin
      .from("spec_phase_checks")
      .update({
        exec_kind: c.to.exec_kind,
        params: c.to.params as unknown,
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.id)
      .eq("exec_kind", "needs_human")
      .select("id");
    if (error) {
      failed.push(`${c.id}: ${error.message}`);
      continue;
    }
    if (!data?.length) {
      skipped++;
      continue;
    }
    ok++;
  }
  return { ok, skipped, failed };
}

// ── Entrypoint ───────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--apply");
  const workspaceArg = args.find((a) => a.startsWith("--workspace="));
  const workspaceFilter = workspaceArg ? workspaceArg.slice("--workspace=".length) : undefined;

  console.log(
    `backfill-spec-checks-to-typed — ${dryRun ? "DRY-RUN (no writes)" : "APPLY"}${workspaceFilter ? ` workspace=${workspaceFilter}` : " (every workspace)"}`,
  );

  const admin = createAdminClient();
  const packageScripts = loadPackageScripts();
  console.log(`package.json scripts loaded: ${packageScripts.size}`);

  const rows = await fetchNeedsHumanRows(admin, workspaceFilter);
  console.log(`fetched ${rows.length} needs_human check row(s)`);

  const proposed: ProposedChange[] = [];
  const buckets = new Map<ExecKind, number>();
  for (const r of rows) {
    const payload = classifyProseCheck(r.description, { packageScripts });
    buckets.set(payload.exec_kind, (buckets.get(payload.exec_kind) ?? 0) + 1);
    if (payload.exec_kind === "needs_human") continue;
    proposed.push({
      id: r.id,
      phase_id: r.phase_id,
      position: r.position,
      description: r.description,
      from: { exec_kind: r.exec_kind, params: r.params },
      to: payload,
    });
  }

  console.log("\n── Classifier manifest ──");
  const kinds = Array.from(buckets.entries()).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of kinds) console.log(`  ${k.padEnd(20)} ${n}`);
  console.log(`\nProposed rewrites: ${proposed.length} row(s)`);

  const sample = proposed.slice(0, 10);
  if (sample.length) {
    console.log("\n── First proposed changes (sample) ──");
    for (const c of sample) {
      console.log(
        `  ${c.id} (phase ${c.phase_id} pos ${c.position}) ${c.to.exec_kind}${
          c.to.params ? ` ${JSON.stringify(c.to.params)}` : ""
        } — "${c.description.slice(0, 80)}${c.description.length > 80 ? "…" : ""}"`,
      );
    }
  }

  if (dryRun) {
    console.log("\nDRY-RUN — no writes. Re-run with --apply to persist.");
    return;
  }
  if (!proposed.length) {
    console.log("\nNo proposed changes — nothing to apply.");
    return;
  }
  const { ok, skipped, failed } = await apply(admin, proposed);
  console.log(`\n✓ applied: ${ok}   ⊘ skipped (already promoted / raced): ${skipped}   ✗ failed: ${failed.length}`);
  if (failed.length) {
    console.log("Failed rows:");
    for (const f of failed) console.log(`  ${f}`);
  }
}

// Run only when executed as a script — NOT when this module is imported (tests import
// `classifyProseCheck` + `loadPackageScripts` and must not trigger the DB-touching main).
const invokedDirectly = (() => {
  try {
    const scriptPath = process.argv[1] ?? "";
    return scriptPath.endsWith("backfill-spec-checks-to-typed.ts") ||
           scriptPath.endsWith("backfill-spec-checks-to-typed.js");
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
