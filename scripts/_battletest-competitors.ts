import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,"");
function nameOk(term:string, name:string){ const t=norm(term), n=norm(name); if(!t||!n)return false; if(n.includes(t)||t.includes(n))return true; const tw=term.toLowerCase().split(/\s+/).filter(w=>w.length>2); const nw=name.toLowerCase().split(/\s+/); return tw.some(w=>nw.includes(w)); }
async function resolve(q:string){
  const r=await fetch(`${BASE}/api/advertisers/search?q=${encodeURIComponent(q)}&country=US`,{headers:{Authorization:`Bearer ${KEY}`}});
  if(!r.ok) return {err:`HTTP ${r.status}`};
  const j:any=await r.json();
  const bm=j.best_match?.meta; const cand=j.candidates?.meta?.[0];
  return { bm, cand, conf:j.best_match?.confidence };
}
(async()=>{
  const a=createAdminClient();
  const { data:comps }=await a.from("competitors").select("id,brand,search_keyword,product_id").eq("workspace_id",WS);
  const { data:prods }=await a.from("products").select("id,title").eq("workspace_id",WS);
  const pn=new Map((prods||[]).map((p:any)=>[p.id,p.title]));
  const bad:string[]=[]; const good:string[]=[];
  for(const c of (comps||[]).sort((x:any,y:any)=>(pn.get(x.product_id)||"").localeCompare(pn.get(y.product_id)||""))){
    const term=(c as any).search_keyword||(c as any).brand;
    const res:any=await resolve(term);
    const prod=pn.get((c as any).product_id)||"?";
    let status="", detail="";
    if(res.err){ status="ERR"; detail=res.err; }
    else if(res.bm){ const ok=res.conf===1 && nameOk(term,res.bm.name); status=ok?"OK":"CHECK"; detail=`→ "${res.bm.name}" (${res.bm.likes} likes, conf=${res.conf})`; }
    else if(res.cand){ status="WEAK"; detail=`no best_match; top candidate "${res.cand.name}" (${res.cand.likes} likes)`; }
    else { status="NO-MATCH"; detail="no meta result"; }
    const line=`[${prod}] "${term}" ${detail}`;
    if(status==="OK") good.push(line); else bad.push(`${status}: ${line}`);
    await new Promise(r=>setTimeout(r,7000));
  }
  console.log(`\n===== ✅ ${good.length} clean · ⚠️ ${bad.length} need attention =====\n`);
  console.log("⚠️ NEED A BETTER SEARCH TERM:\n"+bad.map(b=>"  "+b).join("\n"));
  console.log("\n✅ CLEAN:\n"+good.map(g=>"  "+g).join("\n"));
})().then(()=>process.exit(0));
