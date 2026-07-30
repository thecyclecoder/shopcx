import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0", ACCT="2352876514967984";
(async()=>{
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  const r:any=await (await fetch(`https://graph.facebook.com/${V}/act_${ACCT}/product_catalogs?fields=id,name,product_count&access_token=${token}`)).json();
  console.log("account product_catalogs:", JSON.stringify(r.data||r.error||r).slice(0,500));
  const r2:any=await (await fetch(`https://graph.facebook.com/${V}/act_${ACCT}?fields=business{id,name,owned_product_catalogs{id,name,product_count}}&access_token=${token}`)).json();
  console.log("business catalogs:", JSON.stringify(r2.business?.owned_product_catalogs||r2.error||r2).slice(0,500));
})().then(()=>process.exit(0));
