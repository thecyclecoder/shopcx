import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const ok=await authorSpecRowStructured(
    WS,
    "growth-ads-supervisor-3h-agent",
    {
      title: "Persistent 3-hour ads-supervisor agent — audits Bianca + Dahlia, authors fix-specs, digests to Slack",
      why: "The founder wants a standing every-3-hours supervisory pass over the two growth agents (Bianca the media buyer + Dahlia the ad creative) that survives beyond any interactive session. A CronCreate session-cron dies when the session closes; this must be a deployed box agent (like Reva/Mario/Sol) so it runs unattended. The pass embodies the north star: it supervises the tools and repairs them via specs — it never moves spend itself.",
      what: "A box-run agent fires every 3h: audits crown/kill state, checks whether Bianca acted, checks Dahlia's bins + competitor-seeded static quality, QAs live-ad copy (LF8 + consumer psychology + correct destination), autonomously authors fix-specs for any gap (deduped), and posts one digest to #director-growth-max.",
      summary: "Add an Inngest 3h cron that enqueues a kind='ads-supervisor' box job; add the lane to scripts/builder-worker.ts running a Claude session that does the supervisory pass (getTestingResults → Bianca-acted check → Dahlia bin/seeding check → live-ad LF8 QA → autonomous fix-spec authoring via authorSpecRowStructured → digest via postAsGrowthDirector). Ships with the node-completeness trio (owner + kill-switch + heartbeat + MONITORED_LOOPS entry).",
      owner: "growth",
      parent: '[[../functions/growth]] — "Static-ad optimization" mandate: this is the standing supervisor of the test-and-scale system (Bianca + Dahlia); it keeps the crown/kill loop + creative bins honest and repairs the agents when they drift. Same supervisable-autonomy north star as the media-buyer arming gate. See [[../libraries/media-buyer-agent]] · [[../libraries/testing-results-sdk]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — 3h cron + box lane + node completeness (owner/switch/heartbeat)",
          why: "The agent needs a persistent trigger and must satisfy the node-completeness hard rule before it can run unattended.",
          what: "Add the Inngest cron, the builder-worker lane, and the owner+kill-switch+heartbeat+MONITORED_LOOPS trio.",
          body: "Add src/lib/inngest/ads-supervisor-cadence.ts — an Inngest cron on a 3-hourly schedule (e.g. `14 */3 * * *`) that enqueues ONE agent_jobs row kind='ads-supervisor' per workspace with an active media_buyer_test_cohorts mapping (dedup: skip if a non-terminal ads-supervisor job exists). Add the 'ads-supervisor' kind to the JobKind union + a concurrency-1 lane in scripts/builder-worker.ts that runs a Claude box session (claude -p) for the pass. Node completeness: (1) OWNER — add 'ads-supervisor' → 'growth' in KIND_OWNER_FALLBACK (src/lib/control-tower/node-registry.ts); (2) KILL-SWITCH — a kill_switches ancestry row; (3) HEARTBEAT — emitAgentHeartbeat('ads-supervisor') at end of run; (4) a MONITORED_LOOPS entry in src/lib/control-tower/registry.ts `{ id:'ads-supervisor-cadence', kind:'cron', owner:'growth', expectedCadence:'every 3h (14 */3 * * *)', livenessWindowMs: 4*HOUR }` (4h ≥ 3h×1.2 satisfies assertRegistryInvariants). Run npm run check:node-registry-drift. Update docs/brain/inngest/ads-supervisor-cadence.md + docs/brain/libraries/control-tower.md per CLAUDE.md.",
          verification: "- tsc clean (registry invariants run at import)\n- ads-supervisor is a MONITORED_LOOPS row owned by growth + node-registry drift passes\n- the cron enqueues a kind='ads-supervisor' job and the lane emits a heartbeat",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "ads-supervisor-cadence registered in MONITORED_LOOPS", kind: "auto", exec_kind: "grep", params: { pattern: "ads-supervisor-cadence", path: "src/lib/control-tower/registry.ts", expect: "present" } },
            { position: 3, description: "the box lane handles the ads-supervisor kind", kind: "auto", exec_kind: "grep", params: { pattern: "ads-supervisor", path: "scripts/builder-worker.ts", expect: "present" } },
            { position: 4, description: "node-registry drift check passes (owner agrees across surfaces)", kind: "auto", exec_kind: "unit_test", params: { script: "check:node-registry-drift" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — The supervisory pass + autonomous fix-spec authoring + Slack digest",
          why: "The pass logic is the whole point: catch Bianca/Dahlia drift and repair it via specs, unattended.",
          what: "Implement the 4-step pass and the deduped autonomous fix-spec authoring + the #director-growth-max digest.",
          body: "In the ads-supervisor session/module implement the pass: (1) getTestingResults (testing-results-sdk) for all hero products → apply the iteration_policies decision-tree (crown ≥8 purch & CAC ≤$150 & ≥$450; early-trim ≥$300 with 0 sales; deadline $1,200 without hold band) → the should-pause / should-crown list. (2) For each should-happen action, check whether Bianca acted (media_buyer iteration_actions + director_activity) → if not, author a fix spec (authorSpecRowStructured, owner=growth, machine checks only — NEVER needs_human). (3) Dahlia bins: listReadyToTest depth (archived-excluded) vs floor 4, seeded from THAT product's getProvenCompetitorAngles, statics QA-passing → author a fix spec on any failure. (4) If Bianca is placing test ads, pull each live Meta creative and QA headline/primary-text/destination for LF8 (Life Force 8) + consumer psychology + correct product-matched destination → author a fix spec on any failure. DEDUP every author against getSpec/listSpecs + parked repair jobs. Post ONE director-voice digest to #director-growth-max (postAsGrowthDirector) summarizing findings + authored fix slugs; suppress an identical no-op digest. NEVER move spend / pause / crown / place ads directly. Update docs/brain/lifecycles or a new library page per CLAUDE.md.",
          verification: "- tsc clean\n- the pass reads getTestingResults + listReadyToTest + getProvenCompetitorAngles and posts via postAsGrowthDirector\n- fix-spec authoring goes through authorSpecRowStructured (no needs_human checks) with a dedup guard",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the pass composes the testing-results + ready-to-test + competitor SDKs", kind: "auto", exec_kind: "grep", params: { pattern: "getTestingResults", path: "src/lib", expect: "present" } },
            { position: 3, description: "the pass authors fixes through the structured chokepoint", kind: "auto", exec_kind: "grep", params: { pattern: "authorSpecRowStructured", path: "src/lib", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#static-ad-optimization" },
  );
  console.log(ok?"authored":"author write failed");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
