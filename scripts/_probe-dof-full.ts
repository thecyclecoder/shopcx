import { loadEnv } from "./_bootstrap"; loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", V="v20.0", CREATIVE="1651599292996360";
(async()=>{
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  const r=await fetch(`https://graph.facebook.com/${V}/${CREATIVE}?fields=degrees_of_freedom_spec&access_token=${token}`);
  const j:any=await r.json();
  const feats=j.degrees_of_freedom_spec?.creative_features_spec||{};
  const keys=Object.keys(feats).sort();
  console.log("ALL creative_features_spec keys ("+keys.length+"):");
  console.log(keys.join("\n"));
  console.log("\n>> image/gen-related:");
  console.log(keys.filter(k=>/image|gen|enhanc|standard|touch|background|expand|uncrop|template|visual/i.test(k)).map(k=>`  ${k} = ${feats[k].enroll_status}`).join("\n"));
})().then(()=>process.exit(0));
