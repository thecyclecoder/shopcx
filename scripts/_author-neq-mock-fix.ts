import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const ok=await authorSpecRowStructured(
    WS,
    "media-buyer-agent-test-mock-support-neq-filter",
    {
      title: "Fix regression: teach the media-buyer agent.test.ts query mock the .neq filter",
      why: "The ready-to-test archived-exclusion change (a new `.neq(\"status\",\"archived\")` filter, shipped on main) broke the media-buyer agent test: its hand-rolled Supabase query-builder mock implements select/eq/in/not but not neq, so listReadyToTest throws a `.neq is not a function` TypeError under the test. This is a real regression on main — the box's regression agent confirmed it, and it also surfaces as the failing machine-check on the media-buyer Slack-digest spec, whose unit_test check runs the media-buyer agent test. Pure test-infra gap; the production neq call is correct.",
      what: "Add `.neq` support to the agent.test.ts query-builder mock so the media-buyer agent test passes again and the media-buyer-digest spec's unit_test check goes green.",
      summary: "In src/lib/media-buyer/agent.test.ts extend the makeFakeAdminForProductScope mock to support `.neq(col,val)` — matching the real Supabase builder listReadyToTest now uses.",
      owner: "growth",
      parent: '[[../functions/growth]] — "Media buyer (Bianca, under Max)" mandate: the media-buyer agent test guards Bianca\'s replenish/ready-bin logic; a broken mock blocks that guard + strands the digest spec. See [[../libraries/ready-to-test]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Add .neq to the query-builder mock",
          why: "The mock is missing the one method production now calls; adding it unbreaks the test with zero production change.",
          what: "Extend the Filter union, matchesJoined, the chain object, and the from() wrapper to support .neq.",
          body: "In src/lib/media-buyer/agent.test.ts `makeFakeAdminForProductScope`: (1) add `\"neq\"` to the `Filter.kind` union (currently `\"eq\" | \"in\" | \"not_is_null\"`, ~line 827); (2) in `matchesJoined` (~832) add `if (f.kind === \"neq\" && v === f.val) return false;` (exclude rows whose col equals val); (3) on the chain object `c` add `neq: (col, val) => { filters.push({ kind: \"neq\", col, val }); return c; }` and include it in c's type; (4) in the top-level `from()` return add `neq: (col, val) => chain(table).neq(col, val)`. This mirrors production ready-to-test.ts's `.neq(\"status\",\"archived\")`. Test-file only — no production code changes. If any other hand-rolled Supabase mock in the same file (or a sibling media-buyer test) also exercises listReadyToTest, give it the same `.neq` method.",
          verification: "- tsc clean\n- npm run test:media-buyer-agent passes (the .neq TypeError is gone)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "media-buyer agent test passes (no .neq TypeError)", kind: "auto", exec_kind: "unit_test", params: { script: "test:media-buyer-agent" } },
            { position: 3, description: "the mock now defines a neq method", kind: "auto", exec_kind: "grep", params: { pattern: "neq", path: "src/lib/media-buyer/agent.test.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#media-buyer-bianca-under-max" },
  );
  console.log(ok?"authored":"author write failed");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
