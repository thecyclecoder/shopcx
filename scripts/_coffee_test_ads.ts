import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ACCT = "2352876514967984"; // Amazing Coffee
async function main(){
  const token=await getMetaUserToken(WS);
  if(!token){console.log("no token");return;}
  // list ads created recently with their creative copy + status
  const fields=`name,effective_status,created_time,adset{name,daily_budget,effective_status},creative{object_story_spec,asset_feed_spec,title,body}`;
  const url=`https://graph.facebook.com/v21.0/act_${ACCT}/ads?fields=${encodeURIComponent(fields)}&limit=50&date_preset=maximum`;
  const r=await fetch(url); const j:any=await r.json();
  if(j.error){console.log("ERR",j.error.message);return;}
  const ads=(j.data??[]).filter((a:any)=>a.effective_status!=="DELETED"&&a.effective_status!=="ARCHIVED");
  // sort by created_time desc
  ads.sort((a:any,b:any)=>String(b.created_time).localeCompare(String(a.created_time)));
  console.log(`active-ish ads: ${ads.length}\n`);
  for(const a of ads.slice(0,8)){
    const afs=a.creative?.asset_feed_spec;
    const oss=a.creative?.object_story_spec?.link_data;
    const body = afs?.bodies?.[0]?.text ?? oss?.message ?? a.creative?.body ?? "(none)";
    const title = afs?.titles?.[0]?.text ?? oss?.name ?? a.creative?.title ?? "(none)";
    const desc = afs?.descriptions?.[0]?.text ?? oss?.description ?? "(none)";
    console.log(`━━ ${a.name} [${a.effective_status}] created ${a.created_time}`);
    console.log(`   adset: ${a.adset?.name} budget=${a.adset?.daily_budget} ${a.adset?.effective_status}`);
    console.log(`   PRIMARY: ${String(body).slice(0,120)}`);
    console.log(`   HEADLINE: ${title}`);
    console.log(`   DESC: ${desc}`);
    console.log(`   adId: ${a.id}\n`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
