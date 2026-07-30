import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const token=await getMetaUserToken(WS);
  if(!token){console.log("no token");return;}
  for(const crid of ["2132619427313852","2824641224589928","1507076567274747"]){
    const fields="object_story_spec,asset_feed_spec,image_hash";
    const j:any=await (await fetch(`https://graph.facebook.com/v21.0/${crid}?fields=${fields}&access_token=${token}`)).json();
    console.log(`\n===== creative ${crid} =====`);
    console.log("image_hash:", j.image_hash);
    console.log("object_story_spec:", JSON.stringify(j.object_story_spec));
    console.log("asset_feed_spec keys:", j.asset_feed_spec?JSON.stringify({images:j.asset_feed_spec.images, link_urls:j.asset_feed_spec.link_urls, ctas:j.asset_feed_spec.call_to_action_types, ad_formats:j.asset_feed_spec.ad_formats, bodies:j.asset_feed_spec.bodies?.length, titles:j.asset_feed_spec.titles?.length}):"none");
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
