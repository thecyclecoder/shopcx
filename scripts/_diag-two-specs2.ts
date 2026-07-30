import { loadEnv } from "./_bootstrap"; loadEnv();
import { investigateSpec } from "../src/lib/spec-investigation";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  for(const slug of ["media-buyer-digest-consolidate-product-names-suppress-noop","competitor-sdk-chokepoint-and-per-product-cleanup"]){
    console.log(`\n${"=".repeat(90)}\n### ${slug}`);
    const r:any = await investigateSpec(WS, slug);
    const d = r.diagnosis ?? r;
    console.log("derivedStatus:", d.derivedStatus, "| valeReviewPassed:", d.valeReviewPassed);
    console.log("\nJOBS:");
    for(const j of (d.jobs||[])){
      console.log(`  [${j.kind}] status=${j.status} needsAttn=${j.needsAttentionClass} age=${j.ageMinutes}m branch=${j.branch||"-"} pr=${j.prNumber||"-"}`);
      if(j.error) console.log(`    error: ${String(j.error).slice(0,220)}`);
      if(j.logTail) console.log(`    log: ${String(j.logTail).slice(0,300)}`);
      if((j.pendingPrompts||[]).length) console.log(`    pendingPrompts: ${JSON.stringify(j.pendingPrompts).slice(0,300)}`);
    }
    // whyIsSpecNotBuilding if available
    console.log("\nrecommendation:", JSON.stringify(r.recommendation ?? d.recommendation ?? null).slice(0,400));
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,500));process.exit(1);});
