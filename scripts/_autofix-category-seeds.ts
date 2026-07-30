import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { upsertCompetitor } from "../src/lib/competitors";
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const STRIP=/\s+(collagen|creatine|coffee|nootropic|ashwagandha|drink|supercreamer)$/i;
const norm=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]/g,"");
async function resolve(q:string){
  const r=await fetch(`${BASE}/api/advertisers/search?q=${encodeURIComponent(q)}&country=US`,{headers:{Authorization:`Bearer ${KEY}`}});
  if(!r.ok) return null;
  const j:any=await r.json();
  const all=[...(j.best_match?.meta?[j.best_match.meta]:[]),...(j.candidates?.meta||[])];
  // highest-likes candidate whose normalized name contains/equals the query
  const nq=norm(q);
  const m=all.filter((c:any)=>{const nc=norm(c.name); return nc.includes(nq)||nq.includes(nc);}).sort((a:any,b:any)=>(b.likes||0)-(a.likes||0))[0];
  return m||null;
}
(async()=>{
  const a=createAdminClient();
  const { data:comps }=await a.from("competitors").select("*").eq("workspace_id",WS);
  const targets=(comps||[]).filter((c:any)=>STRIP.test(c.search_keyword||c.brand||""));
  console.log(`${targets.length} category-suffix seeds to fix:\n`);
  for(const c of targets){
    const cur=(c as any).search_keyword||(c as any).brand;
    const bare=cur.replace(STRIP,"").trim();
    const m=await resolve(bare);
    if(m && (m.likes||0)>=1000){
      await upsertCompetitor({ workspace_id:WS, product_id:(c as any).product_id, brand:(c as any).brand, domain:(c as any).domain, pdp_urls:(c as any).pdp_urls, category:(c as any).category, spend_signal:(c as any).spend_signal, source:(c as any).source, status:(c as any).status, evidence:(c as any).evidence, runs_ads_for:(c as any).runs_ads_for, search_keyword:bare } as any);
      console.log(`  ✅ "${cur}" → "${bare}"  (resolves to "${m.name}", ${m.likes} likes, id=${m.id})`);
    } else {
      console.log(`  ❓ "${cur}" → "${bare}"  ${m?`weak: "${m.name}" (${m.likes} likes)`:"NO match"} — LEFT for you`);
    }
    await new Promise(r=>setTimeout(r,7000));
  }
})().then(()=>process.exit(0));
