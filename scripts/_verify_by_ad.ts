import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function readAd(token:string,adId:string,label:string){
  // get current creative id from the ad, then read its copy
  const a:any=await (await fetch(`https://graph.facebook.com/v21.0/${adId}?fields=name,effective_status,creative{id}&access_token=${token}`)).json();
  const crid=a.creative?.id;
  const c:any=await (await fetch(`https://graph.facebook.com/v21.0/${crid}?fields=object_story_spec&access_token=${token}`)).json();
  const ld=c.object_story_spec?.link_data;
  console.log(`\n━━ ${label} [${a.effective_status}] (ad ${adId}, creative ${crid})`);
  console.log(`   PRIMARY: ${String(ld?.message??"(none)").slice(0,90)}`);
  console.log(`   HEADLINE: ${ld?.name??"(none)"}`);
  console.log(`   DESC: ${ld?.description??"(none)"}`);
}
async function main(){
  const token=await getMetaUserToken(WS);
  if(!token){console.log("no token");return;}
  console.log("=== COFFEE (should show NEW copy) ===");
  await readAd(token,"120252363258280184","Coffee competitor");
  await readAd(token,"120252360721070184","Coffee transf 40lb");
  await readAd(token,"120252360720980184","Coffee transf 35lb");
  console.log("\n=== TABS active ads (current copy) ===");
  await readAd(token,"120250143054820326","Tabs skeptic-bloat");
  await readAd(token,"120250066837240326","Tabs ingredient-breakdown");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
