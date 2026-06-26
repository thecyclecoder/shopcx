/**
 * Static-analysis check: no NEW markdown-read site in the PM flow.
 *
 * The PM flow ("every code path that reads a spec to advance, render, or reconcile its state") is
 * supposed to consume `public.specs` + `public.spec_phases` directly via the typed reader
 * (`getSpec` / `listSpecs` in [[../src/lib/specs-table.ts]]) — never a `docs/brain/specs/*.md`
 * HTTP fetch, never `parseSpec` over a raw blob, never `phaseStatesFromRaw` over a markdown
 * string. That is the "Database is the spec" invariant from CLAUDE.md, enforced not just stated.
 *
 * Imports the canonical PM-flow file set, the md-read patterns, and the
 * `INTENTIONAL_MATERIALIZATION` allow-list from `scripts/_audit-pm-md-reads.ts` (Phase 1) — one
 * source of truth for both. Wired into `npm run check:pm-md-reads` + chained into `predeploy`
 * so a regression breaks CI red, not silently. Read-only; never mutates state.
 *
 * Mirrors the `_check-worker-lanes.ts` shape that shipped under the Vale revival spec.
 */
import {
  buildManifest,
  INTENTIONAL_MATERIALIZATION,
  PENDING_PHASE_2_RETIREMENT,
} from "./_audit-pm-md-reads";

function main() {
  const manifest = buildManifest();
  const sites = Object.values(manifest.by_call_site);
  const violations = sites.filter((s) => s.classification === "pm-read-to-retire");
  const allowed = sites.filter((s) => s.classification === "materialization-for-agent-input");

  if (violations.length > 0) {
    console.error(`\n❌ check-pm-md-reads — ${violations.length} unexpected md-read site(s) in PM scope:\n`);
    for (const v of violations) {
      for (const f of v.findings) {
        console.error(`  • ${v.file}:${f.line}  in ${v.fn}  [${f.pattern}]`);
        console.error(`      ${f.snippet}`);
      }
    }
    console.error(
      `\nThe PM flow reads spec state from \`public.specs\` + \`public.spec_phases\` via the typed reader\n` +
      `(\`getSpec\` / \`listSpecs\` in \`src/lib/specs-table.ts\`). NO \`docs/brain/specs/*.md\` HTTP fetch,\n` +
      `NO \`parseSpec\` over a raw blob, NO \`phaseStatesFromRaw\` over a markdown string.\n` +
      `\nIf this finding is intentional materialization, add the (file, fn, reason) triple to BOTH\n` +
      `\`INTENTIONAL_MATERIALIZATION\` in scripts/_audit-pm-md-reads.ts AND the recipe table in\n` +
      `\`docs/brain/recipes/pm-flow-data-sources.md\` — the recipe is the human bar, the audit list is\n` +
      `the machine bar; they must agree.\n`,
    );
    console.error(`Snapshot:`);
    console.error(`  violations (${violations.length}): ${violations.map((v) => `${v.file}::${v.fn}`).sort().join(", ")}`);
    console.error(`  allowed    (${allowed.length}): ${allowed.map((v) => `${v.file}::${v.fn}`).sort().join(", ")}`);
    console.error(`  files scanned: ${manifest.scanned_files}\n`);
    process.exit(1);
  }

  // Hygiene: warn (not fail) on stale allow-list entries — entries that no longer match any
  // real finding. A stale entry is dead allow-list weight; the next maintainer should remove it.
  const allowedHit = new Set(allowed.map((s) => `${s.file}::${s.fn}`));
  const stale = [...INTENTIONAL_MATERIALIZATION, ...PENDING_PHASE_2_RETIREMENT].filter(
    (s) => !allowedHit.has(`${s.file}::${s.fn}`),
  );
  if (stale.length) {
    console.warn(`⚠ check-pm-md-reads — ${stale.length} stale allow-list entry/entries (no matching finding):`);
    for (const s of stale) console.warn(`  • ${s.file}::${s.fn} — ${s.reason}`);
    console.warn(`Remove from the allow-list (and the recipe table if it's an INTENTIONAL_MATERIALIZATION row).`);
  }

  console.log(
    `✓ check-pm-md-reads — ${manifest.scanned_files} PM-flow file(s) scanned; ` +
    `${allowed.length} allowed md-read site(s) (${INTENTIONAL_MATERIALIZATION.length} intentional, ${PENDING_PHASE_2_RETIREMENT.length} pending-retirement); ` +
    `0 unexpected.`,
  );
}

main();
