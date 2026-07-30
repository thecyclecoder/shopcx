import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const ok = await authorSpecRowStructured(
    WS,
    "register-media-buyer-test-cadence-monitored-loop",
    {
      title: "Register the 2h media-buyer-test-cadence cron as a Control Tower monitored loop (owner + switch + heartbeat)",
      why: "The 2-hourly intraday freshness cron `media-buyer-test-cadence` (src/lib/inngest/media-buyer-test-cadence.ts, id='media-buyer-test-cadence', cron '0 */2 * * *') is an unowned, unbeat node — it is NOT in MONITORED_LOOPS and emits NO heartbeat, so if it silently stops firing the test-stats (meta_insights_daily for the test campaigns) go stale and Bianca acts on old numbers, with nothing surfacing the outage. That violates CLAUDE.md's hard rule: 'A node without a switch + heartbeat + owner is incomplete.' Every other cron of its class (budget-watch-cron, today-sync, meta-capi-dispatch-cron) carries a MONITORED_LOOPS row + emitCronHeartbeat; this one doesn't.",
      what: "Give the cron the completeness trio: an owner (growth) MONITORED_LOOPS row, an emitCronHeartbeat at end of run, and a kill_switches ancestry — so a missed tick is visible + stoppable.",
      summary: "Add a `{ id:'media-buyer-test-cadence', kind:'cron', owner:'growth', expectedCadence:'every 2h (0 */2 * * *)', livenessWindowMs: 3*HOUR }` row to MONITORED_LOOPS in src/lib/control-tower/registry.ts, call emitCronHeartbeat('media-buyer-test-cadence') at the end of the cron body, and confirm/add a kill_switches ancestor. Passes assertRegistryInvariants (3h ≥ 2h×1.2) + check:node-registry-drift.",
      owner: "growth",
      parent: '[[../functions/growth]] — "Media buyer (Bianca, under Max)" mandate: the 2h cadence is what keeps Bianca\'s test-stats fresh; an unmonitored freshness loop can go dark and feed her stale numbers. Node-completeness is the north-star supervisability rule. See [[../libraries/control-tower]] · [[../inngest/media-buyer-test-cadence]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — MONITORED_LOOPS row + end-of-run heartbeat",
          why: "Owner + heartbeat are the two missing legs — without the row the loop has no supervisor tile, without the beat a missed tick is invisible.",
          what: "Register the cron in MONITORED_LOOPS (owner=growth) and emit a cron heartbeat at the end of every run.",
          body: "In src/lib/control-tower/registry.ts add a MONITORED_LOOPS entry: `{ id: 'media-buyer-test-cadence', kind: 'cron', owner: 'growth', label: 'Media-buyer test cadence (2h)', description: 'Intraday freshness loop — syncs meta_insights_daily for the media-buyer TEST campaigns (today-inclusive) then fires the media-buyer cadence sweep.', expectedCadence: 'every 2h (0 */2 * * *)', livenessWindowMs: 3 * HOUR }`. The 3h window satisfies assertRegistryInvariants (livenessWindowMs ≥ cadenceMs × 1.2 = 2h × 1.2 = 2.4h) and the 2h cadence clears the 5-min MONITOR_TICK_FLOOR. In src/lib/inngest/media-buyer-test-cadence.ts import emitCronHeartbeat from '@/lib/control-tower/heartbeat' and call `await emitCronHeartbeat('media-buyer-test-cadence', { ok: true, detail: … })` at the END of the cron body (mirror src/lib/inngest/budget-watch.ts). Update docs/brain/inngest/media-buyer-test-cadence.md + docs/brain/libraries/control-tower.md in the same PR per CLAUDE.md.",
          verification: "- tsc clean (assertRegistryInvariants runs at import — a bad window throws)\n- media-buyer-test-cadence is a MONITORED_LOOPS row owned by growth\n- the cron body emits emitCronHeartbeat('media-buyer-test-cadence')",
          checks: [
            { position: 1, description: "tsc --noEmit clean (registry invariants run at import)", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "media-buyer-test-cadence registered in MONITORED_LOOPS", kind: "auto", exec_kind: "grep", params: { pattern: "media-buyer-test-cadence", path: "src/lib/control-tower/registry.ts", expect: "present" } },
            { position: 3, description: "the cron emits a heartbeat at end of run", kind: "auto", exec_kind: "grep", params: { pattern: "emitCronHeartbeat\\(\"media-buyer-test-cadence\"", path: "src/lib/inngest/media-buyer-test-cadence.ts", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Kill-switch ancestry + node-registry drift green",
          why: "The third completeness leg: the loop must be stoppable via a kill_switches row (its own or an ancestor's), and the drift check must confirm every registry surface agrees on its owner.",
          what: "Confirm/add a kill_switches ancestry for the cron and make check:node-registry-drift pass.",
          body: "Confirm media-buyer-test-cadence resolves to an owner via node-registry (resolveNodeOwner) and has a kill_switches ancestor (its own row or the media-buyer branch it belongs to) — add a KIND_OWNER_FALLBACK entry only if the drift check reports it unowned. Run `npm run check:node-registry-drift` — it must pass, proving approval routing / grader scoping / roster all agree on owner=growth. Update docs/brain/libraries/control-tower-node-registry.md + docs/brain/tables/kill_switches.md if a row/fallback is added, in the same PR per CLAUDE.md.",
          verification: "- tsc clean\n- npm run check:node-registry-drift passes (no orphan / owner divergence for the cron)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "node-registry drift check passes (owner agrees across surfaces)", kind: "auto", exec_kind: "unit_test", params: { script: "check:node-registry-drift" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#media-buyer-bianca-under-max" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
