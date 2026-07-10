import { createAdminClient } from "./_bootstrap";
import { parseVerificationBlobToChecks } from "../src/lib/spec-phase-checks-table";
import { checkKey } from "../src/lib/spec-test-runs";

// PROOF for verification-checks-source-of-truth: if renderSpecRow emits `### Verification` from the typed
// spec_phase_checks rows (as `- {description}`) instead of the raw `verification` column, does EVERY phase's
// checkKey SET stay identical? checkKey drives green-matching + regression + the fix loop, so a changed set
// would break the pipeline. We compare the checkKey set Vera would derive from the CURRENT render (parse of
// the column) vs the NEW render (parse of `- {row.description}` lines). Uses the SAME parser + hash the
// pipeline uses.

function keysFromColumnRender(verification: string): Set<string> {
  // Current render = the column verbatim under `### Verification`; parseVerificationBlobToChecks is the
  // canonical extractor the display + green path use.
  return new Set(parseVerificationBlobToChecks(verification).map((c) => checkKey(c.description)));
}
function keysFromChecksRender(verification: string): Set<string> {
  // New render = `- {description}` per typed check, then re-parsed the same way (what Vera would read).
  const rows = parseVerificationBlobToChecks(verification); // the rows are derived from the column today
  const rendered = rows.map((c) => `- ${c.description}`).join("\n");
  return new Set(parseVerificationBlobToChecks(rendered).map((c) => checkKey(c.description)));
}
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

async function main() {
  const admin = createAdminClient();
  const { data: phases, error } = await admin
    .from("spec_phases")
    .select("id, spec_id, position, verification")
    .not("verification", "is", null);
  if (error) throw error;

  let total = 0, stable = 0, drift = 0;
  const driftEx: { spec_id: string; position: number; before: string[]; after: string[] }[] = [];
  for (const p of (phases ?? []) as any[]) {
    const v = (p.verification ?? "").trim();
    if (!v) continue;
    total++;
    const before = keysFromColumnRender(v);
    const after = keysFromChecksRender(v);
    if (setsEqual(before, after)) stable++;
    else {
      drift++;
      if (driftEx.length < 10) driftEx.push({ spec_id: p.spec_id, position: p.position, before: [...before], after: [...after] });
    }
  }
  console.log(`\nPhases with a verification column: ${total}`);
  console.log(`  checkKey-set STABLE under the render flip: ${stable}`);
  console.log(`  checkKey-set DRIFT (would break the pipeline): ${drift}`);
  if (drift) {
    console.log(`\n=== DRIFT (first ${driftEx.length}) — DO NOT SHIP THE FLIP ===`);
    for (const d of driftEx) console.log(`  spec ${d.spec_id} p${d.position}: before=${d.before.length} after=${d.after.length}`);
  } else {
    console.log(`\n✓ Zero checkKey drift across all ${total} phases — the render flip is pipeline-safe.`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
