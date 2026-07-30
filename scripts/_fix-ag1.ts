import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const KEY=process.env.ADLIBRARY_API_KEY, BASE=process.env.ADLIBRARY_BASE||"https://adlibrary.com";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function resolve(q:string){
  const r=await fetch(`${BASE}/api/advertisers/search?q=${encodeURIComponent(q)}&country=US`,{headers:{Authorization:`Bearer ${KEY}`}});
  const j:any=await r.json(); const m=j.best_match?.meta||j.candidates?.meta?.[0];
  return m?`pageId=${m.id} name="${m.name}" likes=${m.likes} conf=${j.best_match?.confidence??"-"}`:"NO match";
}
(async()=>{
  console.log("resolve 'AG1 by Athletic Greens':", await resolve("AG1 by Athletic Greens"));
  const a=createAdminClient();
  const { data:ag1 }=await a.from("competitors").select("id,brand,search_keyword,product_id").eq("workspace_id",WS).ilike("brand","ag1").maybeSingle();
  console.log("current AG1 seed:", JSON.stringify(ag1));
})().then(()=>process.exit(0));
