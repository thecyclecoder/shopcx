import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ACCT = "196487894712827"; // Superfood Tabs
async function main(){
  const token=await getMetaUserToken(WS);
  if(!token){console.log("no token");return;}
  const url=`https://graph.facebook.com/v21.0/act_${ACCT}/ads?fields=name,effective_status,created_time,creative{id}&limit=60&effective_status=["ACTIVE","PAUSED","PENDING_REVIEW","IN_PROCESS","WITH_ISSUES"]&access_token=${token}`;
  const j:any=await (await fetch(url)).json();
  if(j.error){console.log("ERR",j.error.message);return;}
  const ads=(j.data??[]).sort((a:any,b:any)=>String(b.created_time).localeCompare(String(a.created_time)));
  console.log(`Tabs active-ish ads: ${ads.length}`);
  for(const a of ads.slice(0,12)) console.log(`${a.created_time} [${a.effective_status}] crid=${a.creative?.id} adId=${a.id} :: ${a.name}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
