import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ads=[
  {label:"competitor (01:00)", adId:"120252363258280184", crid:"2132619427313852"},
  {label:"transformation A (23:00)", adId:"120252360721070184", crid:"2824641224589928"},
  {label:"transformation B (23:00)", adId:"120252360720980184", crid:"1507076567274747"},
];
async function main(){
  const token=await getMetaUserToken(WS);
  if(!token){console.log("no token");return;}
  for(const a of ads){
    const url=`https://graph.facebook.com/v21.0/${a.crid}?fields=name,title,body,object_story_spec,asset_feed_spec&access_token=${token}`;
    const j:any=await (await fetch(url)).json();
    if(j.error){console.log(`${a.label}: ERR ${j.error.message}`);continue;}
    const afs=j.asset_feed_spec, ld=j.object_story_spec?.link_data;
    const body=afs?.bodies?.map((b:any)=>b.text) ?? [ld?.message ?? j.body];
    const title=afs?.titles?.map((t:any)=>t.text) ?? [ld?.name ?? j.title];
    const desc=afs?.descriptions?.map((d:any)=>d.text) ?? [ld?.description];
    console.log(`\n━━━ ${a.label}  (ad ${a.adId})`);
    console.log(`PRIMARY: ${JSON.stringify(body)}`);
    console.log(`HEADLINE: ${JSON.stringify(title)}`);
    console.log(`DESC: ${JSON.stringify(desc)}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
