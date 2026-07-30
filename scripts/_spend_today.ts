import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const accts=[{n:"Amazing Coffee",id:"2352876514967984"},{n:"Superfood Tabs",id:"196487894712827"}];
async function acct(token:string,id:string,preset:string){
  const url=`https://graph.facebook.com/v21.0/act_${id}/insights?date_preset=${preset}&fields=spend,impressions,actions&access_token=${token}`;
  const j:any=await (await fetch(url)).json();
  if(j.error) return {err:j.error.message};
  const d=j.data?.[0];
  const pur=(d?.actions??[]).find((a:any)=>a.action_type==="purchase")?.value ?? 0;
  return {spend:Number(d?.spend??0), impr:Number(d?.impressions??0), purch:Number(pur)};
}
async function main(){
  const token=await getMetaUserToken(WS);
  if(!token){console.log("no token");return;}
  for(const a of accts){
    const today=await acct(token,a.id,"today");
    const d7=await acct(token,a.id,"last_7d");
    console.log(`${a.n}:`);
    console.log(`  TODAY: ${JSON.stringify(today)}`);
    console.log(`  LAST 7d: ${JSON.stringify(d7)}`);
    // active ad-level spend today (which ads are actually spending)
    const url=`https://graph.facebook.com/v21.0/act_${a.id}/ads?fields=name,effective_status,insights.date_preset(today){spend,actions}&limit=60&effective_status=["ACTIVE"]&access_token=${token}`;
    const j:any=await (await fetch(url)).json();
    const spenders=(j.data??[]).map((ad:any)=>({name:ad.name,status:ad.effective_status,spend:Number(ad.insights?.data?.[0]?.spend??0)})).filter((x:any)=>x.spend>0).sort((a:any,b:any)=>b.spend-a.spend);
    console.log(`  active ads spending today: ${spenders.length}`);
    for(const s of spenders.slice(0,6)) console.log(`    $${s.spend.toFixed(2)} — ${String(s.name).slice(0,46)}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
