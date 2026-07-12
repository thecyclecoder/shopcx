/**
 * marco-logistics-director-seat Phase 1 — read-only investigation probe.
 *
 * Verifies the Phase 1 rubric ("run a scratch tsx script that imports (or attempts to import) the
 * availability-toggle + swap-enrollment executors → expect either both resolve callable (choose A)
 * or one/both fail to resolve (choose B)"). Prints a landing-shape summary and exits 0.
 *
 * NO mutations. Safe to run anywhere with the repo. Not tied to Supabase — probes the source tree.
 *
 * Findings (2026-07-12):
 *   1. Storefront-availability toggle — NO callable helper. `grep -rn
 *      'toggleStorefrontAvailability|setStorefrontAvailability|availabilityToggle' src/` returns
 *      zero hits. `src/lib/logistics/crisis-forecast.ts:187` describes the play in prose only
 *      ("Pull ${swap} OFF the storefront + portal options (availability lever)") — no executor.
 *   2. Auto-re-add / swap-enrollment writer — CALLABLE. `src/lib/action-executor.ts:2129`
 *      exports the `crisis_enroll` executor and `:2248` exports `crisis_set_auto_readd`; both
 *      mutate `crisis_customer_actions.auto_readd` through the normal orchestrator dispatch.
 *   3. Provenance / build model — OFF-LIMITS to Ada. `docs/brain/functions/logistics.md:40`
 *      "Kept off public.specs by founder directive (2026-07-10) — no devops operation. This is
 *      a deliberate, bounded exception to 'Ada is the sole builder'; general doctrine unchanged."
 *
 * ANY ONE of (1) or (3) missing forces landing B. Both point to B. Decision recorded via
 * `scripts/apply-marco-landing-decision.ts` → `spec_phases.metadata.marco_landing = 'B'`.
 *
 * Run:  npx tsx scripts/_marco-phase1-executor-probe.ts
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const REPO = resolve(__dirname, "..");

interface ProbeFinding {
  key: string;
  ok: boolean;
  detail: string;
}

function grepFor(pattern: RegExp, path: string): { hit: boolean; matchedLine: string | null } {
  if (!existsSync(path)) return { hit: false, matchedLine: null };
  const body = readFileSync(path, "utf8");
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return { hit: true, matchedLine: `${path.slice(REPO.length + 1)}:${i + 1}: ${lines[i].trim()}` };
  }
  return { hit: false, matchedLine: null };
}

async function main() {
  const findings: ProbeFinding[] = [];

  // (1) Storefront-availability toggle — no callable helper.
  const availabilityPatterns = [
    /toggleStorefrontAvailability/,
    /setStorefrontAvailability/,
    /availabilityToggle/,
  ];
  const availabilityCandidates = [
    resolve(REPO, "src/lib/logistics/crisis-forecast.ts"),
    resolve(REPO, "src/lib/logistics/cover.ts"),
    resolve(REPO, "src/lib/shopify.ts"),
    resolve(REPO, "src/lib/shopify-theme.ts"),
    resolve(REPO, "src/lib/action-executor.ts"),
  ];
  let availabilityHit: string | null = null;
  for (const path of availabilityCandidates) {
    for (const pat of availabilityPatterns) {
      const r = grepFor(pat, path);
      if (r.hit) { availabilityHit = r.matchedLine; break; }
    }
    if (availabilityHit) break;
  }
  findings.push({
    key: "storefront_availability_toggle_callable",
    ok: availabilityHit != null,
    detail: availabilityHit ?? "no toggleStorefrontAvailability/setStorefrontAvailability/availabilityToggle helper across the candidate library files — the crisis-forecast play remains prose-only",
  });

  // (2) Swap-enrollment writer — callable executor.
  const actionExec = resolve(REPO, "src/lib/action-executor.ts");
  const enroll = grepFor(/^\s*crisis_enroll:\s*async/m, actionExec);
  const autoReadd = grepFor(/^\s*crisis_set_auto_readd:\s*async/m, actionExec);
  findings.push({
    key: "swap_enrollment_writer_callable",
    ok: enroll.hit && autoReadd.hit,
    detail: [enroll.matchedLine, autoReadd.matchedLine].filter(Boolean).join(" · ") ||
      "crisis_enroll / crisis_set_auto_readd not found in action-executor.ts",
  });

  // (3) Founder-directive off-limits flag.
  const logisticsMd = resolve(REPO, "docs/brain/functions/logistics.md");
  const provenance = grepFor(/Kept off `public\.specs` by founder directive/, logisticsMd);
  findings.push({
    key: "logistics_tooling_off_limits_to_ada",
    ok: provenance.hit,
    detail: provenance.matchedLine ?? "no founder-directive off-limits flag in logistics.md — reinterpret",
  });

  const availabilityCallable = findings[0].ok;
  const enrollCallable = findings[1].ok;
  const offLimits = findings[2].ok;

  const decision: "A" | "B" = availabilityCallable && enrollCallable && !offLimits ? "A" : "B";

  console.log("── marco-logistics-director-seat Phase 1 · executor-surface probe ──");
  for (const f of findings) {
    console.log(`  [${f.ok ? "✓" : "×"}] ${f.key}: ${f.detail}`);
  }
  console.log("");
  console.log(`  availability_toggle_callable = ${availabilityCallable}`);
  console.log(`  swap_enrollment_callable     = ${enrollCallable}`);
  console.log(`  logistics_off_limits_to_ada  = ${offLimits}`);
  console.log("");
  console.log(`⇒ marco_landing = '${decision}'`);
  console.log(
    decision === "A"
      ? "  Rationale: BOTH executors are callable AND logistics.md does NOT flag them off-limits to Ada."
      : "  Rationale: at least one executor is not callable OR logistics.md flags this tooling off-limits to Ada (a deliberate exception to 'Ada is the sole builder', per founder directive 2026-07-10).",
  );
  console.log("");
  console.log("Persist with:  npx tsx scripts/apply-marco-landing-decision.ts  (prod-mutating; needs approval)");
}
main().catch((e) => { console.error(e); process.exit(1); });
