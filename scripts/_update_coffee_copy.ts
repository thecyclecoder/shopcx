import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ACCT = "2352876514967984";
const PAGE = "104094194369069";
const IG = "17841409041235543";
const LINK = "https://superfoodscompany.com/products/amazing-coffee";

const ads = [
  { label:"Ad1 competitor (coffee hero)", adId:"120252363258280184", imageHash:"f01af1bc9b7e0ceb29e5aa2f6bc76c00", name:"Dahlia · Amazing Coffee · competitor",
    headline:"Clean Energy. No Jitters. No Crash.",
    primary:"Your morning coffee — but it works for you. Amazing Coffee is real, delicious coffee infused with superfoods that curb cravings, deliver clean all-day energy (no jitters, no 2pm crash), and keep you full.\n\nSame ritual you love. Better results.\n🌿 Non-GMO · 3rd-party tested · USA-made · 700,000+ customers\n\nUp to 34% off + free shipping today. 👉 Shop Now",
    description:"$1.76/serving vs a $4–8 latte · Free shipping" },
  { label:"Ad2 transformation (Barbara 40lb)", adId:"120252360721070184", imageHash:"fb145a8fb0270955642c24bc4c0877e6", name:"Dahlia · Amazing Coffee · transformation",
    headline:"The Coffee Swap Women Over 50 Swear By",
    primary:"\"I lost 40+ pounds — and the only thing I changed was my morning coffee.\" — Barbara H.\n\nIf you love your morning cup but hate the afternoon crash and the cravings that hit all day, this is the swap thousands of women over 50 are making. Amazing Coffee tastes like the coffee you love, infused with superfoods that help curb appetite, support clean energy, and keep you full — no jitters, no crash.\n\n💛 700,000+ customers · 30-day money-back guarantee. Up to 34% off + free shipping today. 👉 Shop Now",
    description:"Non-GMO · 30-day money-back guarantee" },
  { label:"Ad3 transformation (35lb)", adId:"120252360720980184", imageHash:"a23a9664053f4e59f8ef07c804bdba2d", name:"Dahlia · Amazing Coffee · transformation",
    headline:"She Swapped Her Coffee. The Rest Followed.",
    primary:"\"I truly believe this coffee is one reason I lost 35 pounds.\" — real customer\n\nNo crash diet. No giving up her morning cup. She just swapped it for Amazing Coffee — real coffee infused with superfoods that help curb cravings, keep you full, and deliver clean energy with no jitters or afternoon slump.\n\n🌿 Non-GMO · 3rd-party tested · 700,000+ customers · 30-day money-back guarantee. Up to 34% off + free shipping today. 👉 Shop Now",
    description:"$1.76/serving · Free shipping · Money-back guarantee" },
];

async function graphPost(path:string, body:any, token:string){
  const r=await fetch(`https://graph.facebook.com/v21.0/${path}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,access_token:token})});
  return r.json();
}

async function main(){
  const token=await getMetaUserToken(WS);
  if(!token){console.log("no token");return;}
  for(const a of ads){
    const spec={ page_id:PAGE, instagram_user_id:IG, link_data:{ link:LINK, message:a.primary, name:a.headline, description:a.description, image_hash:a.imageHash, call_to_action:{type:"SHOP_NOW"} } };
    const cr=await graphPost(`act_${ACCT}/adcreatives`,{name:a.name,object_story_spec:spec},token);
    if(cr.error){console.log(`❌ ${a.label} creative: ${cr.error.message}`);continue;}
    const upd=await graphPost(`${a.adId}`,{creative:{creative_id:cr.id}},token);
    if(upd.error){console.log(`❌ ${a.label} adUpdate: ${upd.error.message} (creative ${cr.id})`);continue;}
    console.log(`✅ ${a.label}: creative=${cr.id} adUpdated=${JSON.stringify(upd)}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
