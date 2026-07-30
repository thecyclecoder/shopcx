import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533";
async function main() {
  const admin = createAdminClient();
  const ready = await listReadyToTest(admin, WS);
  const coffee = ready.filter((r:any) => r.product_id === COFFEE);
  console.log(`Coffee ready-to-test bin: ${coffee.length}`);
  for (const c of coffee) console.log(` - ${c.campaign_id ?? c.id} | ${c.headline ?? c.title ?? "?"} | created ${c.created_at ?? "?"}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error("ERR", e.message);process.exit(1);});
