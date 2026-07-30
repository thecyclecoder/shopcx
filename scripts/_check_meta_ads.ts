import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const adIds=["120252360721070184","120252360720980184"];
async function main(){
  const token = await getMetaUserToken(WS);
  if(!token){ console.log("no token"); return; }
  for(const id of adIds){
    const url=`https://graph.facebook.com/v21.0/${id}?fields=name,effective_status,adset{name,daily_budget,effective_status},insights.date_preset(today){spend,impressions,actions}&access_token=${token}`;
    const r=await fetch(url); const j:any=await r.json();
    if(j.error){console.log(`${id} ERR:`,j.error.message);continue;}
    const ins=j.insights?.data?.[0];
    console.log(`ad ${id}: adStatus=${j.effective_status} adsetStatus=${j.adset?.effective_status} name="${(j.name??"").slice(0,44)}" adsetDailyBudget=${j.adset?.daily_budget} spendToday=$${ins?.spend??0} impr=${ins?.impressions??0}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
