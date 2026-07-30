import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SHARED_CAMP="120249256874270682";
const ZEN_ORIGINALS=["120249262237450682","120249262236550682","120249262235100682","120249256883430682"];
const GRAPH="https://graph.facebook.com/v21.0";
async function gget(path:string,params:Record<string,string>,token:string){const u=new URL(`${GRAPH}/${path}`);for(const[k,v]of Object.entries(params))u.searchParams.append(k,v);u.searchParams.append("access_token",token);const r=await fetch(u);return r.json();}
async function main(){
  const token=await getMetaUserToken(WS);
  // all adsets in shared/Guru campaign, full status
  const r=await gget(`${SHARED_CAMP}/adsets`,{fields:"id,name,status,effective_status",limit:"50"},token!);
  console.log(`Guru Focus testing campaign ${SHARED_CAMP} — all adsets:`);
  for(const a of (r.data??[])){
    const isZen = ZEN_ORIGINALS.includes(a.id);
    console.log(`   ${isZen?"👉ZEN ":"  Guru"} [${a.status}/${a.effective_status}] ${a.name}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
