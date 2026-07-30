import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const s:any=await getSpec(WS,"dahlia-copy-author-box-session");
  console.log("status:", s?.status);
  console.log("phases:");
  for(const p of s?.phases||[]) console.log(`  P${p.position} [${p.status}] pr=${p.pr_number||"-"} sha=${(p.merge_sha||"").slice(0,9)||"-"} — ${(p.title||"").slice(0,70)}`);
})().then(()=>process.exit(0));
