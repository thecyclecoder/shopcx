import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0", AD="120252471398980184";
(async()=>{
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  for(const fmt of ["MOBILE_FEED_STANDARD","INSTAGRAM_STORY","FACEBOOK_STORY_MOBILE","INSTAGRAM_STANDARD","RIGHT_COLUMN_STANDARD"]){
    const j:any=await (await fetch(`https://graph.facebook.com/${V}/${AD}/previews?ad_format=${fmt}&access_token=${token}`)).json();
    const body=j.data?.[0]?.body||"";
    const hasFrame=/preview_iframe\.php|<iframe/i.test(body);
    console.log(`${fmt.padEnd(24)} ${j.error?("ERR "+String(j.error.message).slice(0,50)):(hasFrame?"✓ renders (preview iframe)":"✗ no frame len="+body.length)}`);
  }
})().then(()=>process.exit(0));
