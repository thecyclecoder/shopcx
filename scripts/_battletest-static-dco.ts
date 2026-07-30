/**
 * BATTLE-TEST (founder-directed 2026-07-16): prove Meta accepts a STATIC multi-image + multi-copy
 * Dynamic Creative before we spec it. Uploads 5 of our static images, builds one adcreative with
 * asset_feed_spec {images[5], titles[4], bodies[4], link_urls, SINGLE_IMAGE, DEGREES_OF_FREEDOM},
 * and creates a PAUSED ad in a PAUSED Amazing Coffee adset. Prints the full Meta error on reject.
 * Read-mostly + one paused ad object (reversible). Not production code — the real builder goes in the spec.
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken, uploadAdImage } from "../src/lib/meta-ads";

const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const V="v20.0";
const ACCT="2352876514967984";
const PAGE="104094194369069";
const IG="17841409041235543";
const ADSET="120252357431540184"; // "Static · Amazing Coffee · advertorial" (PAUSED)
const LANDING="https://superfoodscompany.com/products/amazing-coffee";
const HEADLINES=["Coffee that loves you back","The upgrade your morning deserves","Real energy, zero crash","What your coffee's been missing"];
const BODIES=[
  "Most coffee spikes you then drops you. This one gives you steady, all-morning energy — with superfoods in every cup.",
  "Swap your regular brew for a cup that actually works with your body. Smooth energy, no jitters, no 11am crash.",
  "Thousands made the switch and never looked back. Same ritual you love — now doing something for you.",
  "Your morning cup, upgraded: adaptogens and superfoods for calm, focused energy that lasts.",
];

async function graphPost(path:string, body:Record<string,unknown>, token:string){
  const p=new URLSearchParams();
  for(const[k,v]of Object.entries(body)){ if(v==null)continue; p.append(k, typeof v==="object"?JSON.stringify(v):String(v)); }
  p.append("access_token", token);
  const res=await fetch(`https://graph.facebook.com/${V}/${path}`,{method:"POST",body:p});
  const json:any=await res.json();
  if(!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json.error||json)}`);
  return json;
}
function objectPath(url:string){ return decodeURIComponent(url.split("/object/sign/ad-tool/")[1].split("?")[0]); }

async function main(){
  const admin=createAdminClient();
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");

  // 5 static image bytes via service-role storage download (signed URLs may be expired)
  const { data:rows } = await admin.from("ad_videos").select("static_jpg_url").eq("workspace_id",WS)
    .eq("media_kind","static").not("static_jpg_url","is",null).limit(12);
  const hashes:string[]=[];
  for(const r of rows||[]){
    if(hashes.length>=5) break;
    const path=objectPath((r as any).static_jpg_url);
    const { data:blob, error }=await admin.storage.from("ad-tool").download(path);
    if(error||!blob){ console.log("  skip (download fail):",path.slice(-30),error?.message); continue; }
    const bytes=Buffer.from(await blob.arrayBuffer());
    try{
      const h=await uploadAdImage(token, ACCT, bytes, path.split("/").pop()!);
      hashes.push(h); console.log(`  uploaded image ${hashes.length}: ${h.slice(0,16)}…`);
    }catch(e:any){ console.log("  upload fail:",e.message?.slice(0,120)); }
  }
  if(hashes.length<2) throw new Error(`only ${hashes.length} images uploaded — need >=2`);
  console.log(`\n${hashes.length} images uploaded. Building asset_feed_spec creative…`);

  const imgs=hashes.map(h=>({hash:h}));
  const titles=HEADLINES.map(text=>({text}));
  const bodies=BODIES.map(text=>({text}));
  const descriptions=[{text:"Superfood coffee for steady, all-morning energy."}];
  const cta="SHOP_NOW";

  // Candidate payload shapes — try until Meta accepts the static multi-image + multi-copy DCO.
  const candidates:{tag:string, oss:any, afs:any}[]=[
    { tag:"A: link_urls{website+display} + SINGLE_IMAGE + DOF",
      oss:{page_id:PAGE,instagram_user_id:IG},
      afs:{images:imgs,titles,bodies,descriptions,link_urls:[{website_url:LANDING,display_url:LANDING}],call_to_action_types:[cta],ad_formats:["SINGLE_IMAGE"],optimization_type:"DEGREES_OF_FREEDOM"} },
    { tag:"B: link in object_story_spec.link_data.link + afs variants (no link_urls)",
      oss:{page_id:PAGE,instagram_user_id:IG,link_data:{link:LANDING,call_to_action:{type:cta,value:{link:LANDING}}}},
      afs:{images:imgs,titles,bodies,descriptions,call_to_action_types:[cta],ad_formats:["SINGLE_IMAGE"]} },
    { tag:"C: link_data.link + afs WITH link_urls (belt+braces)",
      oss:{page_id:PAGE,instagram_user_id:IG,link_data:{link:LANDING}},
      afs:{images:imgs,titles,bodies,descriptions,link_urls:[{website_url:LANDING,display_url:LANDING}],call_to_action_types:[cta],ad_formats:["SINGLE_IMAGE"],optimization_type:"DEGREES_OF_FREEDOM"} },
    { tag:"D: link_urls only, no ad_formats, no optimization_type",
      oss:{page_id:PAGE,instagram_user_id:IG},
      afs:{images:imgs,titles,bodies,descriptions,link_urls:[{website_url:LANDING,display_url:LANDING}],call_to_action_types:[cta]} },
  ];

  let creative:any=null, winner="";
  for(const c of candidates){
    try{
      creative=await graphPost(`act_${ACCT}/adcreatives`,{
        name:`BATTLETEST · Amazing Coffee · static DCO [${c.tag.split(":")[0]}]`,
        object_story_spec:c.oss, asset_feed_spec:c.afs,
      }, token);
      winner=c.tag; console.log(`✓ adcreative created via [${c.tag}]:`, creative.id); break;
    }catch(e:any){ console.log(`  ✗ [${c.tag}] → ${e.message.slice(0,140)}`); }
  }
  if(!creative) throw new Error("all candidate creative shapes rejected");

  const ad=await graphPost(`act_${ACCT}/ads`,{
    name:"BATTLETEST · Amazing Coffee · static DCO (PAUSED)",
    adset_id:ADSET,
    creative:{ creative_id:creative.id },
    status:"PAUSED",
  }, token);
  console.log("✓ AD CREATED (PAUSED):", ad.id);
  console.log(`\nSUCCESS — static multi-image + multi-copy Dynamic Creative accepted by Meta.`);
  console.log(`ad_id=${ad.id} creative_id=${creative.id} adset=${ADSET} (both paused).`);
}
main().then(()=>process.exit(0)).catch(e=>{ console.error("\n✗ FAILED:", e.message); process.exit(1); });
