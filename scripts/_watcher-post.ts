import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSlackToken, postAsGrowthDirector } from "../src/lib/slack";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CH="C0BFW5YUVC1";
const text = [
"*Ads supervision — 3h pass*",
"",
"*Crown/kill:* no action due. Every dud is already paused; nothing has hit crown criteria yet. Watching two burners above the hold band but under the $1,200 deadline — Coffee skeptic-v3 ($807 / CAC $269) and Tabs skeptic-bloat ($635 / CAC $317). Bianca is armed and correctly idle.",
"",
"*Bins:* nominal depth is 6–8 per product (floor 4), but I found a real quality gap — 10 of Dahlia's competitor creatives are status=ready with *no angle_id*, so they count toward depth but Bianca can't replenish from them (no ad-copy source → she fail-closes). Real deployable depth is lower than the headline.",
"",
"*Fix authored (autonomous):* `dahlia-creative-requires-angle-before-ready` — a competitor creative can't reach 'ready' without an angle, plus a backfill of the 10 existing null-angle rows. In the build queue.",
"",
"*Live-ad copy QA:* sampled active ads — headlines are LF8-aligned (energy/focus/strength, no MSRP, no fabricated testimonials). Clean.",
].join("\n");
(async()=>{
  const token=await getSlackToken(WS);
  if(!token){ console.log("no slack token"); return; }
  const r=await postAsGrowthDirector(token, CH, [], text);
  console.log(r.ok?`posted ts=${r.ts}`:"post failed");
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
