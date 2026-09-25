/**
 * Release fulfillment orders Shopify is holding in SCHEDULED for ShopCX subscriptions.
 *
 * A delivery-policy anchor makes Shopify hold an off-anchor charge's fulfillment until the next
 * anchor day. The customer has PAID and is waiting, the order reads PAID, and nothing reports it.
 * The anchors are removed going forward; this releases the ones already stuck.
 *
 *   npx tsx scripts/_release-scheduled-fulfillments.ts [--apply]
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { decrypt } from "../src/lib/crypto";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY=process.argv.includes("--apply");
async function main(){
  const admin=createAdminClient();
  const {data:w}=await admin.from("workspaces").select("shopify_myshopify_domain,shopify_access_token_encrypted").eq("id",WS).single();
  const token=decrypt(w!.shopify_access_token_encrypted!);
  const gq=async(q:string,v:any={})=>{const r=await fetch(`https://${w!.shopify_myshopify_domain}/admin/api/2025-07/graphql.json`,{method:"POST",headers:{"X-Shopify-Access-Token":token,"Content-Type":"application/json"},body:JSON.stringify({query:q,variables:v})});return r.json();};

  const j=await gq(`query{orders(first:100,query:"created_at:>=2026-09-18",sortKey:CREATED_AT,reverse:true){edges{node{
    name displayFinancialStatus fulfillmentOrders(first:3){edges{node{id status fulfillAt}}}}}}}`);
  const stuck:{name:string;id:string;fulfillAt:string}[]=[];
  for(const e of j.data?.orders?.edges??[]){
    for(const f of e.node.fulfillmentOrders?.edges??[]){
      if(f.node.status==="SCHEDULED") stuck.push({name:e.node.name,id:f.node.id,fulfillAt:f.node.fulfillAt});
    }
  }
  console.log(`fulfillment orders held in SCHEDULED: ${stuck.length}`);
  for(const s of stuck) console.log(`  ${s.name}  fulfillAt ${String(s.fulfillAt).slice(0,10)}`);
  if(!APPLY){ console.log("\ndry run — pass --apply to release"); return; }

  for(const s of stuck){
    const r=await gq(`mutation($id:ID!){fulfillmentOrderOpen(id:$id){fulfillmentOrder{id status} userErrors{message}}}`,{id:s.id});
    const ue=r.data?.fulfillmentOrderOpen?.userErrors ?? r.errors;
    const now=r.data?.fulfillmentOrderOpen?.fulfillmentOrder?.status;
    console.log(`  ${s.name}: ${ue?.length?`✗ ${JSON.stringify(ue)}`:`released → ${now}`}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
