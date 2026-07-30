import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const s:any=await getSpec(WS,"lf8-live-ad-gate-broaden-vocab-and-gate-deactivation-on-performance");
  if(!s){console.log("NOT FOUND");return;}
  console.log(`status=${s.status} owner=${s.owner} auto_build=${s.auto_build} phases=${(s.phases||[]).length}`);
  for(const p of (s.phases||[])) console.log(`  · ${p.title} — checks:${(p.checks||[]).length} (${(p.checks||[]).map((c:any)=>c.exec_kind).join(",")})`);
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
