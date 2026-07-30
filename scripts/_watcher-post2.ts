import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSlackToken, postAsGrowthDirector } from "../src/lib/slack";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CH="C0BFW5YUVC1";
const text = [
"*Ads supervision — pass (root-caused the Tabs 2/4 stall)*",
"",
"*THE issue — Superfood Tabs frozen at 2/4:* found it. Tabs' active per-test cohort has `adset_template = NULL` (all 5 other products have a valid template). Bianca's replenish fail-closes on every attempt — 'per-test cohort missing adset_template' — and only writes a silent audit row, so Tabs sat under-provisioned with no alert. The angle side is fine (8 of 10 Tabs creatives are angled); the null template was the binding blocker.",
"",
"*Fix authored (autonomous):* `media-buyer-cohort-adset-template-guard-backfill-and-escalate` — (1) backfill the null template so Tabs can mint its 2 missing adsets, (2) guard provisioning so an active cohort can never persist a null template, (3) escalate an under-provisioned active cohort instead of silently deferring. In the build queue. (Direct DB backfill was correctly blocked by the write rail → doing it via the spec's Phase 1.)",
"",
"*Crown/kill:* no action due — duds already paused; two burners (Coffee skeptic-v3 $807/CAC$269, Tabs skeptic-bloat $635/CAC$317) above the hold band but under the $1,200 deadline, so correctly still testing. Bianca armed + acting correctly on the kill path.",
"",
"*Bins:* nominal 6–8/product, but the 10 null-angle Dahlia creatives from last pass still inflate depth — covered by `dahlia-creative-requires-angle-before-ready` (already in queue).",
].join("\n");
(async()=>{
  const token=await getSlackToken(WS);
  if(!token){ console.log("no slack token"); return; }
  const r=await postAsGrowthDirector(token, CH, [], text);
  console.log(r.ok?`posted ts=${r.ts}`:"post failed");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
