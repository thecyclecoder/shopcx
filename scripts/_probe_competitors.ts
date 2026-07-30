import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const HERO=["Amazing Coffee","Amazing Creamer","Superfood Tabs","Creatine Prime+","Ashwavana Guru Focus","Ashwavana Zen Relax"];
async function main(){
  const admin=createAdminClient();
  const { data: sample } = await admin.from("competitors").select("*").limit(1);
  console.log("competitors columns:", sample?.[0]?Object.keys(sample[0]).join(", "):"(no rows)");
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id",WS);
  const pName=new Map((prods||[]).map((p:any)=>[p.id,p.title]));
  const heroIds=new Set((prods||[]).filter((p:any)=>HERO.includes(p.title)).map((p:any)=>p.id));
  const { data: comps } = await admin.from("competitors").select("id, product_id, name").eq("workspace_id",WS);
  console.log(`\ntotal competitors: ${(comps||[]).length}`);
  const byProd=new Map<string,number>(); let orphans=0;
  for(const c of (comps||[]) as any[]){
    if(!c.product_id || !heroIds.has(c.product_id)){ orphans++; continue; }
    byProd.set(c.product_id,(byProd.get(c.product_id)||0)+1);
  }
  console.log("\n=== competitors per HERO product ===");
  for(const p of (prods||[]) as any[]){ if(!HERO.includes(p.title)) continue;
    console.log(`  ${p.title}: ${byProd.get(p.id)||0}`); }
  console.log(`\norphan/non-hero competitors (no product_id or not a hero): ${orphans}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
