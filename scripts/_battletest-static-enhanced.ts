/**
 * BATTLE-TEST v2 (founder-directed 2026-07-16): the CORRECT shape.
 * Same winning creative as v1 [C] (single object_story_spec.link_data.link + asset_feed_spec
 * titles[4]/bodies[4] multi-copy — confirmed NOT DCO, passes through), BUT:
 *   - ONE static image lives in link_data.image_hash (so the ad RENDERS media), no image variation
 *   - degrees_of_freedom_spec.creative_features_spec turns ON Meta's creative enhancements
 *     (image_background_gen AI image gen + uncrop/touchups/brightness/animation/text/cta) so the
 *     ad is supercharged against creative fatigue without becoming a DCO ad.
 * Deletes the broken 0-media v1 ad first. Publishes PAUSED into the same Amazing Coffee adset.
 * This time we VERIFY IT RENDERS MEDIA via the previews endpoint (v1's lesson: field-presence != render).
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const V="v20.0";
const ACCT="2352876514967984";
const PAGE="104094194369069";
const IG="17841409041235543";
const ADSET="120252357431540184"; // "Static · Amazing Coffee · advertorial" (PAUSED)
const LANDING="https://superfoodscompany.com/products/amazing-coffee";
const IMAGE_HASH="06fb3d88d4d43eed0a5bc63e6b43ac3c"; // already uploaded + ACTIVE 1080x1350 on this account
const OLD_AD="120252469954990184", OLD_CREATIVE="2784992095220990"; // prior v2 (5 opt-ins) — replace with max set

const HEADLINES=["Coffee that loves you back","The upgrade your morning deserves","Real energy, zero crash","What your coffee's been missing"];
const BODIES=[
  "Most coffee spikes you then drops you. This one gives you steady, all-morning energy — with superfoods in every cup.",
  "Swap your regular brew for a cup that actually works with your body. Smooth energy, no jitters, no 11am crash.",
  "Thousands made the switch and never looked back. Same ritual you love — now doing something for you.",
  "Your morning cup, upgraded: adaptogens and superfoods for calm, focused energy that lasts.",
];

// Anti-fatigue creative enhancements. image_background_gen (AI image gen) needs a product catalog
// ("No catalog selected"), so it's excluded from this single-image no-catalog max set.
const FEATURES_RICH=["image_uncrop","image_touchups","image_brightness_and_contrast","image_templates","image_animation","image_enhancement","adapt_to_placement","enhance_cta","text_optimizations","add_text_overlay"];
const FEATURES_SAFE=["image_touchups","image_brightness_and_contrast","image_uncrop","enhance_cta","adapt_to_placement"];
const dof=(keys:string[])=>({creative_features_spec:Object.fromEntries(keys.map(k=>[k,{enroll_status:"OPT_IN"}]))});

async function graph(method:"POST"|"DELETE", path:string, body:Record<string,unknown>, token:string){
  const p=new URLSearchParams();
  for(const[k,v]of Object.entries(body)){ if(v==null)continue; p.append(k, typeof v==="object"?JSON.stringify(v):String(v)); }
  p.append("access_token", token);
  const url=`https://graph.facebook.com/${V}/${path}`;
  const res=method==="DELETE" ? await fetch(`${url}?${p}`,{method}) : await fetch(url,{method,body:p});
  const json:any=await res.json();
  if(!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.error||json)}`);
  return json;
}

async function main(){
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");

  // 0. delete broken v1
  for(const [id,label] of [[OLD_AD,"ad"],[OLD_CREATIVE,"creative"]] as const){
    try{ await graph("DELETE", id, {}, token); console.log(`  deleted broken v1 ${label}: ${id}`); }
    catch(e:any){ console.log(`  (v1 ${label} ${id} not deleted: ${e.message.slice(0,80)})`); }
  }

  // 1. build the enhanced creative — single image in link_data, multi-copy in asset_feed_spec, enhancements ON
  const mk=(features:string[])=>({
    name:"BATTLETEST v2 · Amazing Coffee · single static + multi-copy + enhancements",
    object_story_spec:{
      page_id:PAGE, instagram_user_id:IG,
      link_data:{
        image_hash:IMAGE_HASH, link:LANDING,
        name:HEADLINES[0], message:BODIES[0],
        call_to_action:{type:"SHOP_NOW", value:{link:LANDING}},
      },
    },
    asset_feed_spec:{
      titles:HEADLINES.map(text=>({text})),
      bodies:BODIES.map(text=>({text})),
      descriptions:[{text:"Superfood coffee for steady, all-morning energy."}],
      link_urls:[{website_url:LANDING, display_url:LANDING}],
      call_to_action_types:["SHOP_NOW"],
      optimization_type:"DEGREES_OF_FREEDOM",
    },
    degrees_of_freedom_spec:dof(features),
  });

  let creative:any=null, usedFeatures:string[]=[];
  for(const [feats,label] of [[FEATURES_RICH,"rich"],[FEATURES_SAFE,"safe"]] as const){
    try{ creative=await graph("POST", `act_${ACCT}/adcreatives`, mk(feats), token); usedFeatures=feats;
      console.log(`✓ creative created (${label} enhancement set, ${feats.length} opt-ins):`, creative.id); break; }
    catch(e:any){ console.log(`  ✗ ${label} set → ${e.message.slice(0,160)}`); }
  }
  if(!creative) throw new Error("creative rejected with both enhancement sets");

  // 2. paused ad
  const ad=await graph("POST", `act_${ACCT}/ads`, {
    name:"BATTLETEST v2 · Amazing Coffee · enhanced static (PAUSED)",
    adset_id:ADSET, creative:{creative_id:creative.id}, status:"PAUSED",
  }, token);
  console.log("✓ AD CREATED (PAUSED):", ad.id);

  // 3. VERIFY — renders media? enhancements opted in? not DCO?
  const pv:any=await (await fetch(`https://graph.facebook.com/${V}/${ad.id}/previews?ad_format=MOBILE_FEED_STANDARD&access_token=${token}`)).json();
  const pbody=pv.data?.[0]?.body||"";
  const rendersMedia=/scontent|fbcdn|background-image|<img/i.test(pbody);
  const cr:any=await (await fetch(`https://graph.facebook.com/${V}/${creative.id}?fields=asset_feed_spec,object_story_spec,degrees_of_freedom_spec&access_token=${token}`)).json();
  const optedIn=Object.entries(cr.degrees_of_freedom_spec?.creative_features_spec||{}).filter(([,v]:any)=>v.enroll_status==="OPT_IN").map(([k])=>k);
  const afsImages=(cr.asset_feed_spec?.images||[]).length;
  console.log("\n=== VERIFY ===");
  console.log("renders media?           ", rendersMedia, `(preview len ${pbody.length})`);
  console.log("link_data.image_hash set?", !!cr.object_story_spec?.link_data?.image_hash);
  console.log("titles / bodies:         ", (cr.asset_feed_spec?.titles||[]).length, "/", (cr.asset_feed_spec?.bodies||[]).length);
  console.log("asset_feed_spec.images:  ", afsImages, "(0 = single static, NOT image-DCO)");
  console.log("enhancements OPT_IN:     ", JSON.stringify(optedIn));
  console.log("\nAds Manager: https://adsmanager.facebook.com/adsmanager/manage/ads?act="+ACCT+"&selected_ad_ids="+ad.id);
  console.log(`ad_id=${ad.id} creative_id=${creative.id} (both paused)`);
  if(!rendersMedia) console.log("\n⚠️  STILL 0 MEDIA — needs another shape.");
}
main().then(()=>process.exit(0)).catch(e=>{ console.error("\n✗ FAILED:", e.message); process.exit(1); });
