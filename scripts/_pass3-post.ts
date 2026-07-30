import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSlackToken, postAsGrowthDirector } from "../src/lib/slack";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906"; const CH="C0BFW5YUVC1";
const text=[
"*Ads supervision — 3h pass*",
"",
"*Crown/kill:* 0 crowns due. Bianca's own detector flags 6 duds — she's already paused *4* of them this cycle (armed, acting on the decision-tree). *2 still active:* one borderline (`…5815`, $326, cost-per-ATC $81.50 — just over the $80 line, flips in/out) and one sustained (`…4030`, $684 / 2 purch / $342 CAC). The $684 one is worth watching — if it's still unpaused next pass, that's a real gap.",
"",
"*Bins:* healthy across all 6 hero products — the null-angle guard (`dahlia-creative-requires-angle-before-ready`) shipped and worked: angled/usable ratios are high now (Coffee 21/23, Tabs 8/9, Creamer 5/5, Guru Focus 4/5). Only K-Cups (a non-hero variant) is below floor.",
"",
"*⚠️ Tabs still blocked:* the cohort-template fix (`media-buyer-cohort-adset-template-guard-backfill-and-escalate`) *shipped*, but the Tabs cohort `adset_template` is *still NULL* — the guard + escalate phases landed, but the one-time backfill never executed against prod, so Tabs still can't replenish. This needs the backfill to actually run (shipped ≠ ran). Flagging rather than re-authoring — the code fix already merged.",
"",
"*No new fix-specs this pass* — the two gaps are (a) Bianca timing/borderline, not a systemic miss, and (b) an un-executed backfill from an already-shipped spec, not a missing fix.",
].join("\n");
(async()=>{
  const token=await getSlackToken(WS); if(!token){console.log("no token");return;}
  const r=await postAsGrowthDirector(token,CH,[],text);
  console.log(r.ok?`posted ts=${r.ts}`:"post failed");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
