import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0";
const ACCT="2352876514967984", CREATIVE="1651599292996360";
(async()=>{
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  // What does a creative's degrees_of_freedom_spec / creative_features look like on our account?
  const r=await fetch(`https://graph.facebook.com/${V}/${CREATIVE}?fields=id,degrees_of_freedom_spec,object_type,creative_sourcing_spec&access_token=${token}`);
  const j:any=await r.json();
  console.log("=== our battletest creative dof spec ===");
  console.log(JSON.stringify(j, null, 1).slice(0,1500));
  // Try the account-level generated-image / creative feature endpoints that might exist
  for(const ep of [
    `act_${ACCT}/generatepreviews`,
    `act_${ACCT}?fields=capabilities`,
  ]){
    try{ const rr=await fetch(`https://graph.facebook.com/${V}/${ep}${ep.includes("?")?"&":"?"}access_token=${token}`);
      const jj:any=await rr.json(); console.log(`\n--- ${ep} ---`, JSON.stringify(jj.error||jj).slice(0,300)); }catch(e:any){ console.log(ep, e.message?.slice(0,120)); }
  }
})().then(()=>process.exit(0));
