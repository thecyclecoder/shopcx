import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getProvenCompetitorAngles } from "../src/lib/ads/creative-sourcing";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
async function main() {
  const admin = createAdminClient();
  const { count } = await admin.from("creative_skeletons")
    .select("*",{count:"exact",head:true}).eq("workspace_id",WS).eq("product_id",COFFEE);
  console.log(`creative_skeletons for Coffee: ${count}`);
  try {
    const angles = await getProvenCompetitorAngles(admin, { workspaceId: WS, productId: COFFEE, limit: 12 } as any);
    console.log(`getProvenCompetitorAngles → ${angles?.length ?? 0}`);
    for (const a of (angles??[]).slice(0,8)) console.log(` - [${(a as any).source}] ${(a as any).hook ?? (a as any).angle ?? "?"}`);
  } catch(e:any){ console.error("angles err:", e.message); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
