import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const HERO=["Amazing Coffee","Amazing Creamer","Superfood Tabs","Creatine Prime+","Ashwavana Guru Focus","Ashwavana Zen Relax"];
async function main(){
  const admin=createAdminClient();
  const { data: comps, error } = await admin.from("competitors").select("id, product_id, brand, status").eq("workspace_id",WS);
  if(error){console.log("ERR:",error.message);return;}
  console.log(`total competitors: ${(comps||[]).length}`);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id",WS);
  const pName=new Map((prods||[]).map((p:any)=>[p.id,p.title]));
  const heroIds=new Set((prods||[]).filter((p:any)=>HERO.includes(p.title)).map((p:any)=>p.id));
  const byProd=new Map<string,number>(); let orphan=0;
  for(const c of (comps||[]) as any[]){ if(c.product_id&&heroIds.has(c.product_id)) byProd.set(c.product_id,(byProd.get(c.product_id)||0)+1); else orphan++; }
  for(const t of HERO){ const pid=[...heroIds].find(id=>pName.get(id)===t); console.log(`  ${t}: ${pid?(byProd.get(pid)||0):0}`); }
  console.log(`  ORPHANS (no product / non-hero): ${orphan}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
