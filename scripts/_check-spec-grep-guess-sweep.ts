/**
 * grep-check-guess-guard-closes-alternation-and-pin-gaps Phase 3 — read-only sweep over every
 * non-folded spec's `grep` verification checks. Closes the "existing dormant traps" tail: Phase 1
 * split alternation branches and Phase 2 made the pin binding, but every check authored BEFORE
 * either fix was written under the old rules and could still strand its build for three days on an
 * assertion that can never match. Two such checks were repaired by hand on 2026-08-02; any others
 * are still ticking.
 *
 * What it does (read-only, spec-SDK-only — never a raw `.from("specs"|"spec_phases"|"spec_phase_checks")`):
 *   1. `listSpecs(workspace_id, { scope: 'active' })` — every non-folded spec on the board.
 *   2. Per spec, for each phase: build the SAME `specText` the author-time chokepoint uses
 *      (`[spec.why, spec.what, phase.title, phase.why, phase.what, phase.body]`, filter-joined),
 *      then `listPhaseChecks(phase.id)` and iterate every `exec_kind='grep'` row.
 *   3. Re-run the repaired `detectBuilderChosenNameInGrep(pattern, specText)` — the same predicate
 *      the guard uses today. Any non-null verdict is an offender the repaired guard would now
 *      reject.
 *   4. Print offenders as `spec / phase / check` with the corrected suggestion; exit non-zero when
 *      any are found.
 *
 * REPORT ONLY. Never rewrites a check. A wrong automatic loosening is worse than a known list — it
 * can make an assertion pass without the behaviour existing, which is precisely the failure mode
 * this whole area exists to prevent.
 *
 * Sanity: the two known-good repairs already applied on 2026-08-02 must NOT be flagged
 *   • subscription-mutation spec's `verifyContractEndState` + `test:.*mutation-verify`
 *   • placeholder spec's `resolvePlaceholderSafeMessage|stripUnsubstitutedPlaceholders`
 *
 *   Run:   npx tsx scripts/_check-spec-grep-guess-sweep.ts                        # human-readable
 *          npx tsx scripts/_check-spec-grep-guess-sweep.ts --json                  # one JSON object
 *          npx tsx scripts/_check-spec-grep-guess-sweep.ts --workspace <uuid>      # override default
 *   Wired: `npm run check:spec-grep-guess-sweep` → this script.
 *   NOT chained into `predeploy` — the sweep needs live DB creds (`listSpecs` hits the pooled RPC)
 *   and is an operator-triggered inventory pass, not a per-PR gate.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { listSpecs, type SpecRow, type SpecPhaseRow } from "../src/lib/specs-table";
import { listPhaseChecks, detectBuilderChosenNameInGrep } from "../src/lib/spec-phase-checks-table";

const DEFAULT_WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

interface Offender {
  spec_slug: string;
  spec_title: string;
  phase_position: number;
  phase_title: string;
  check_position: number;
  check_description: string;
  pattern: string;
  reason: string;
  suggested: string;
}

/**
 * Same shape the author-time chokepoint (`author-spec.ts` `assertEveryPhaseHasChecks` per-phase
 * specText) uses — spec why/what + phase title/why/what/body. The pin rule is a case-insensitive
 * `.includes()`, so the sweep verdict exactly mirrors what the guard sees at authoring.
 */
function buildPerPhaseSpecText(spec: SpecRow, phase: SpecPhaseRow): string {
  return [spec.why, spec.what, phase.title, phase.why, phase.what, phase.body]
    .filter(Boolean)
    .join("\n");
}

async function sweep(workspaceId: string): Promise<{ offenders: Offender[]; specsScanned: number; grepChecksScanned: number }> {
  const specs = await listSpecs(workspaceId, { scope: "active" });
  const offenders: Offender[] = [];
  let grepChecksScanned = 0;
  for (const spec of specs) {
    for (const phase of spec.phases ?? []) {
      const specText = buildPerPhaseSpecText(spec, phase);
      const checks = await listPhaseChecks(phase.id);
      for (const check of checks) {
        if (check.exec_kind !== "grep") continue;
        grepChecksScanned++;
        const params = check.params as { pattern?: unknown } | null;
        const pattern = params && typeof params.pattern === "string" ? params.pattern : null;
        if (!pattern) continue;
        const verdict = detectBuilderChosenNameInGrep(pattern, specText);
        if (verdict) {
          offenders.push({
            spec_slug: spec.slug,
            spec_title: spec.title,
            phase_position: phase.position,
            phase_title: phase.title,
            check_position: check.position,
            check_description: check.description,
            pattern,
            reason: verdict.reason,
            suggested: verdict.suggested,
          });
        }
      }
    }
  }
  return { offenders, specsScanned: specs.length, grepChecksScanned };
}

function fmtOffender(o: Offender): string {
  return (
    `  • ${o.spec_slug} / phase ${o.phase_position} (${o.phase_title}) / check ${o.check_position}\n` +
    `      pattern: ${o.pattern}\n` +
    `      reason:  ${o.reason}\n` +
    `      try:     grep.pattern: ${o.suggested}`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const wsFlagIdx = args.indexOf("--workspace");
  const workspaceId =
    wsFlagIdx >= 0 && args[wsFlagIdx + 1]
      ? args[wsFlagIdx + 1]!
      : process.env.SHOPCX_WORKSPACE_ID || DEFAULT_WORKSPACE_ID;

  const report = await sweep(workspaceId);

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          workspace_id: workspaceId,
          specs_scanned: report.specsScanned,
          grep_checks_scanned: report.grepChecksScanned,
          offender_count: report.offenders.length,
          offenders: report.offenders,
        },
        null,
        2,
      ),
    );
    process.exit(report.offenders.length ? 1 : 0);
  }

  const banner =
    `[check:spec-grep-guess-sweep] workspace=${workspaceId}  specs=${report.specsScanned}  ` +
    `grep-checks=${report.grepChecksScanned}  offenders=${report.offenders.length}`;
  if (report.offenders.length === 0) {
    console.log(`✅ ${banner}`);
    console.log(
      `\nNo grep check would be rejected by the repaired guard. The two known-good repairs ` +
      `(subscription-mutation + placeholder specs, hand-fixed 2026-08-02) are already correctly ` +
      `spec-pinned or use a real regex, so they do NOT surface here.`,
    );
    process.exit(0);
  }

  console.error(`❌ ${banner}`);
  console.error(
    `\n${report.offenders.length} grep check(s) already carry the defect the repaired guard now rejects ` +
    `(reported, not rewritten — an automatic loosening can make an assertion pass without the behaviour ` +
    `existing, which is exactly the failure mode this area exists to prevent):`,
  );
  for (const o of report.offenders) console.error(fmtOffender(o));
  console.error(
    `\nRepair by hand: name the exact identifier in the OWNING spec's body (so the pin escape valve ` +
    `fires + the builder is bound to it via grep-check-guess-guard-closes-alternation-and-pin-gaps ` +
    `Phase 2), or replace the pattern with the corrected suggestion above.`,
  );
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[check:spec-grep-guess-sweep] failed:", e instanceof Error ? e.message : e);
    process.exit(2);
  });
}
