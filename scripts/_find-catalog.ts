import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0", ACCT="2352876514967984";
(async()=>{
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  for(const ep of [
    `me/businesses?fields=id,name,owned_product_catalogs{id,name,product_count}`,
    `act_${ACCT}?fields=id,name,business{id,name}`,
    `me/assigned_product_catalogs?fields=id,name,product_count`,
  ]){
    const r:any=await (await fetch(`https://graph.facebook.com/${V}/${ep}${ep.includes("?")?"&":"?"}access_token=${token}`)).json();
    console.log(`\n--- ${ep.split("?")[0]} ---`);
    console.log(JSON.stringify(r.error||r.data||r).slice(0,600));
  }
})().then(()=>process.exit(0));
