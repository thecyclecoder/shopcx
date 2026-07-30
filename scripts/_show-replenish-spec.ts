import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  for (const slug of ["media-buyer-replenish-per-product-scope","ready-to-test-exclude-archived-url-removed-creatives"]) {
    const s = await getSpec(WS, slug);
    if(!s){console.log(slug,"NOT FOUND");continue;}
    console.log(`\n### ${slug} — status=${s.status} auto_build=${(s as any).auto_build}`);
    for (const p of (s.phases??[]) as any[]) console.log(`  ${p.title}\n    ${(p.body||"").slice(0,240)}`);
  }
})().then(()=>process.exit(0));
