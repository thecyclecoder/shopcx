/**
 * BATTLE-TEST (founder-directed 2026-07-16): prove Meta accepts a PLACEMENT-customized ad with
 * 3 placement images (stories 9:16, feed 4:5, right-column 1:1) + 4 headline variations + 4 primary
 * text variations — mirrors the existing createDualAssetCreative shape (optimization_type:"PLACEMENT",
 * asset_customization_rules, NOT Dynamic Creative → portable into scaling campaigns), extended from
 * 2 buckets to 3. Published PAUSED into the Amazing Coffee adset. Verifies it RENDERS media.
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0";
const ACCT="2352876514967984", PAGE="104094194369069", IG="17841409041235543";
const ADSET="120252357431540184"; // Static · Amazing Coffee · advertorial (PAUSED)
const LANDING="https://superfoodscompany.com/products/amazing-coffee";
// 3 sizes already uploaded + ACTIVE on this account
const IMG_STORIES="be587df7396b382ef858ed8ba38ae2e3"; // 1080x1920 (9:16)
const IMG_FEED="06fb3d88d4d43eed0a5bc63e6b43ac3c";    // 1080x1350 (4:5)
const IMG_RIGHTCOL="2e874f6a7f36ef1bae0d3f19cba8d125"; // 1080x1080 (1:1)
const CTA="SHOP_NOW";
const HEADLINES=["Coffee that loves you back","The upgrade your morning deserves","Real energy, zero crash","What your coffee's been missing"];
const BODIES=[
  "Most coffee spikes you then drops you. This one gives you steady, all-morning energy — with superfoods in every cup.",
  "Swap your regular brew for a cup that actually works with your body. Smooth energy, no jitters, no 11am crash.",
  "Thousands made the switch and never looked back. Same ritual you love — now doing something for you.",
  "Your morning cup, upgraded: adaptogens and superfoods for calm, focused energy that lasts.",
];
const OLD=["120252469982380184"]; // prior enhanced battle-test ad — delete to keep the adset clean

async function graph(method:"POST"|"DELETE", path:string, body:Record<string,unknown>, token:string){
  const p=new URLSearchParams();
  for(const[k,v]of Object.entries(body)){ if(v==null)continue; p.append(k, typeof v==="object"?JSON.stringify(v):String(v)); }
  p.append("access_token", token);
  const url=`https://graph.facebook.com/${V}/${path}`;
  const res=method==="DELETE" ? await fetch(`${url}?${p}`,{method}) : await fetch(url,{method,body:p});
  const j:any=await res.json();
  if(!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j.error||j)}`);
  return j;
}

async function main(){
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  for(const id of OLD){ try{ await graph("DELETE", id, {}, token); console.log("deleted prior battle-test ad", id); }catch(e:any){ console.log("(prior ad not deleted:", e.message.slice(0,60)+")"); } }

  const prefix=`cx_${Date.now()}`;
  const lbl=(kind:string,p:string)=>({name:`${prefix}_${kind}_${p}`});
  const PLACEMENTS=["stories","feed","rightcol","default"];
  const allBody=PLACEMENTS.map(p=>lbl("body",p));
  const allTitle=PLACEMENTS.map(p=>lbl("title",p));
  const allUrl=PLACEMENTS.map(p=>lbl("url",p));

  // Each headline/body is eligible for EVERY placement (labeled with all placement labels) → Meta
  // rotates the 4 copy variations within each placement. Images are placement-specific.
  const titles=HEADLINES.map(text=>({text, adlabels:allTitle}));
  const bodies=BODIES.map(text=>({text, adlabels:allBody}));
  const link_urls=[{website_url:LANDING, display_url:LANDING, adlabels:allUrl}];

  const images=[
    {hash:IMG_STORIES,  adlabels:[lbl("img","stories")]},
    {hash:IMG_FEED,     adlabels:[lbl("img","feed"), lbl("img","default")]}, // feed 4:5 doubles as the fallback
    {hash:IMG_RIGHTCOL, adlabels:[lbl("img","rightcol")]},
  ];
  const rule=(p:string, priority:number, spec:Record<string,unknown>)=>({
    customization_spec:{age_min:13, age_max:65, ...spec},
    image_label:lbl("img",p), body_label:lbl("body",p), title_label:lbl("title",p), link_url_label:lbl("url",p),
    priority,
  });
  const asset_customization_rules=[
    rule("feed", 1, { publisher_platforms:["facebook","instagram"],
      facebook_positions:["feed","profile_feed","marketplace"], instagram_positions:["stream","explore_home","profile_feed"] }),
    rule("stories", 2, { publisher_platforms:["facebook","instagram"],
      facebook_positions:["story","facebook_reels","video_feeds"], instagram_positions:["story","reels"] }),
    rule("rightcol", 3, { publisher_platforms:["facebook"], facebook_positions:["right_hand_column","search"] }),
    rule("default", 4, {}),
  ];

  const creative=await graph("POST", `act_${ACCT}/adcreatives`, {
    name:"BATTLETEST · Amazing Coffee · 3-placement + 4hl + 4pt",
    object_story_spec:{ page_id:PAGE, instagram_user_id:IG },
    asset_feed_spec:{
      ad_formats:["AUTOMATIC_FORMAT"],
      optimization_type:"PLACEMENT",
      images, titles, bodies,
      descriptions:[{text:"Superfood coffee for steady, all-morning energy."}],
      call_to_action_types:[CTA],
      link_urls,
      asset_customization_rules,
    },
    degrees_of_freedom_spec:{ creative_features_spec:{ text_optimizations:{ enroll_status:"OPT_OUT" } } },
  }, token);
  console.log("✓ creative:", creative.id);

  const ad=await graph("POST", `act_${ACCT}/ads`, {
    name:"BATTLETEST · 3-placement + 4hl + 4pt (PAUSED)",
    adset_id:ADSET, creative:{creative_id:creative.id}, status:"PAUSED",
  }, token);
  console.log("✓ AD (PAUSED):", ad.id);

  // VERIFY — renders media + all variations stuck + not DCO
  const cr:any=await (await fetch(`https://graph.facebook.com/${V}/${creative.id}?fields=image_url,asset_feed_spec&access_token=${token}`)).json();
  const afs=cr.asset_feed_spec||{};
  console.log("\n=== VERIFY ===");
  console.log("renders media?      ", !!cr.image_url);
  console.log("images:             ", (afs.images||[]).length, "(3 placement buckets)");
  console.log("titles / bodies:    ", (afs.titles||[]).length, "/", (afs.bodies||[]).length);
  console.log("customization rules:", (afs.asset_customization_rules||[]).length);
  console.log("optimization_type:  ", afs.optimization_type, "(PLACEMENT = placement-customized, not DCO/portable)");
  console.log("\nAds Manager: https://adsmanager.facebook.com/adsmanager/manage/ads?act="+ACCT+"&selected_ad_ids="+ad.id);
  console.log(`ad_id=${ad.id} creative_id=${creative.id} (paused)`);
}
main().then(()=>process.exit(0)).catch(e=>{ console.error("\n✗ FAILED:", e.message); process.exit(1); });
