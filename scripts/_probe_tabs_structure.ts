import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TABS_CAMP="120250066504550326";
const GRAPH="https://graph.facebook.com/v21.0";
async function gget(path:string,params:Record<string,string>,token:string){const u=new URL(`${GRAPH}/${path}`);for(const[k,v]of Object.entries(params))u.searchParams.append(k,v);u.searchParams.append("access_token",token);const r=await fetch(u);const j=await r.json();if(!r.ok||j.error)throw new Error(JSON.stringify(j.error??j));return j;}
async function main(){
  const token=await getMetaUserToken(WS);
  const as=await gget(`${TABS_CAMP}/adsets`,{fields:"id,name,effective_status",limit:"50"},token!);
  console.log(`Tabs campaign ${TABS_CAMP} — adsets + ad counts:`);
  for(const a of (as.data??[])){
    const ads=await gget(`${a.id}/ads`,{fields:"id,name,effective_status",limit:"50"},token!);
    const list=(ads.data??[]);
    console.log(`  [${a.effective_status}] ${a.name}  → ${list.length} ad(s): ${list.map((x:any)=>`${x.effective_status}`).join(", ")}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
