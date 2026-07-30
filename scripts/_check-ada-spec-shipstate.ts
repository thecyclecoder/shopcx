import { loadEnv } from "./_bootstrap"; loadEnv();
import { getSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{ const s:any=await getSpec(WS,"ada-reacts-to-approvals-immediately-never-sits");
  console.log("status(stored)=",s.status,"phases=",(s.phases||[]).map((p:any)=>`${p.title?.slice(0,20)}=${p.status} pr=${p.pr} sha=${(p.merge_sha||"").slice(0,8)}`).join(" | "));
})().then(()=>process.exit(0));
