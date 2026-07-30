import { createAdminClient } from "@/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", CREAMER="61a4490e-cb2a-4f65-9613-faab40f0b153";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ts=()=>new Date().toISOString().slice(11,19);
async function count(a:any){const {data}=await a.from("creative_skeletons").select("advertiser").eq("workspace_id",WS).eq("product_id",CREAMER) as any;
  const b:Record<string,number>={}; for(const s of (data||[]))b[s.advertiser||"?"]=(b[s.advertiser||"?"]||0)+1; return {total:(data||[]).length,b};}
async function m(){const a=createAdminClient();
  for(let i=0;i<7;i++){await sleep(45000); const c=await count(a);
    const spoiled=(c.b["SpoiledChild"]||0)+(c.b["Spoiled Child"]||0)+(c.b["Wellness Guru"]||0);
    console.log(`[${ts()}] Creamer skeletons=${c.total} | SpoiledChild/WellnessGuru=${spoiled} | ${JSON.stringify(c.b)}`);
    if(spoiled>0 && i>=2) break;
  }
}
m().then(()=>process.exit(0)).catch(e=>console.error("THREW:",e.message));
