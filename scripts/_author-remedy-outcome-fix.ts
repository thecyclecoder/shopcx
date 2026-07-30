import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "cancel-flow-remedy-outcome-invalid-enum-values",
    {
      title: "Fix cancel-flow: remedy_outcomes inserts use invalid outcome values ('cancelled'/'saved') that the CHECK constraint rejects — every outcome row from the journey route is silently dropped",
      why: "The journey cancel-flow completion route inserts remedy_outcomes rows with outcome='cancelled' (customer churned, no remedy) and outcome='saved' (customer accepted a remedy), but the remedy_outcomes_outcome_check constraint only permits NULL, 'accepted', 'passed_over', or 'rejected'. So both inserts throw a check-constraint violation (Postgres 23514), and because the inserts are not error-checked they fail silently — the outcome row never lands. Live proof: the table has 1875 rejected / 195 passed_over / 104 accepted / 296 null rows and ZERO 'cancelled' or 'saved' rows, so these two paths have never recorded an outcome. The cancel-flow success-rate analytics that read remedy_outcomes are therefore missing every completion that goes through this route.",
      what: "Map the two outcomes to the constraint's real vocabulary — cancelled→rejected, saved→accepted — and error-check the inserts so a future constraint mismatch surfaces loudly instead of silently dropping analytics.",
      summary: "In src/app/api/journey/[token]/complete/route.ts change the remedy_outcomes insert at ~line 1038 from outcome:'cancelled' to 'rejected', and at ~line 1122 from outcome:'saved' to 'accepted' (matching the remedy_outcomes_outcome_check allowed set and the existing rejected/accepted/passed_over data); check the insert error so a silent drop can't recur.",
      owner: "retention",
      parent: '[[../functions/retention]] — "Churn prevention & win-back" mandate: the cancel-flow remedy outcomes are this mandate\'s core measurement; a silently-failing insert means the save/churn rates are blind. See [[../lifecycles/cancel-flow]] and [[../tables/remedy_outcomes]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Use the constraint's real outcome vocabulary and error-check the insert",
          why: "outcome='cancelled' and outcome='saved' violate remedy_outcomes_outcome_check, so both inserts throw and, being unchecked, drop the row silently.",
          what: "Map cancelled→rejected and saved→accepted, and surface an insert error instead of swallowing it.",
          body: "In src/app/api/journey/[token]/complete/route.ts: (1) the cancelled branch's insert (~line 1031-1042) currently sets `outcome: \"cancelled\"` with `accepted: false` — change it to `outcome: \"rejected\"` (the customer rejected all remedies and churned; matches the allowed set NULL|accepted|passed_over|rejected and the existing 1875 rejected rows). (2) the saved branch's insert (~line 1113-1123) currently sets `outcome: \"saved\"` with `accepted: true` — change it to `outcome: \"accepted\"` (the customer accepted a remedy; matches the existing accepted rows). Do NOT change the constraint — the code is the outlier; the DB vocabulary is authoritative (database is the spec). (3) Capture the insert result and log a warning on error (`const { error } = await admin.from('remedy_outcomes').insert({...}); if (error) console.warn('[cancel-flow] remedy_outcomes insert failed', error.message)`) at BOTH sites so a future constraint mismatch is visible rather than silent. Confirm the allowed values against the live constraint (NULL|accepted|passed_over|rejected). Update docs/brain/tables/remedy_outcomes.md and docs/brain/lifecycles/cancel-flow.md (outcome vocabulary) per CLAUDE.md.",
          verification: "- tsc clean\n- no remedy_outcomes insert uses outcome:'cancelled' or outcome:'saved'\n- the inserts error-check the result",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the invalid outcome:'cancelled' literal is gone from the route", kind: "auto", exec_kind: "grep", params: { pattern: "outcome: \"cancelled\"", path: "src/app/api/journey/[token]/complete/route.ts", expect: "absent" } },
            { position: 3, description: "the invalid outcome:'saved' literal is gone from the route", kind: "auto", exec_kind: "grep", params: { pattern: "outcome: \"saved\"", path: "src/app/api/journey/[token]/complete/route.ts", expect: "absent" } },
            { position: 4, description: "the corrected 'rejected' outcome is used", kind: "auto", exec_kind: "grep", params: { pattern: "outcome: \"rejected\"", path: "src/app/api/journey/[token]/complete/route.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#churn-prevention-win-back" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
