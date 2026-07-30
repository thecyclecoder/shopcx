/**
 * MB launcher (reusable) — publish QA'd static creatives into their test ad sets, ACTIVE.
 * Pass concept keys as args (default: all present). Skips a file that's missing.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { readFileSync } from "fs";
import { getMetaUserToken, uploadAdImage, createAd, updateObjectStatus } from "../src/lib/meta-ads";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ACCT = "2352876514967984";
const CAMP = "120252196683350184";
const PAGE = "104094194369069";
const IG = "17841409041235543";
const PDP = "https://superfoodscompany.com/products/amazing-coffee";
const SCRATCH = "/private/tmp/claude-501/-Users-admin-Projects-shopcx/c70e6ebd-556b-41d7-a1aa-17c4f938977d/scratchpad";
const GB = "https://graph.facebook.com/v21.0";

async function createStaticCreative(token: string, a: { name: string; imageHash: string; headline: string; primary: string }): Promise<string> {
  const urlTags = "utm_source=meta&utm_medium=paid_social&utm_campaign=mb-test-round1&utm_content={{ad.id}}&utm_term=shopify_pdp";
  const body = {
    name: a.name,
    object_story_spec: {
      page_id: PAGE, instagram_user_id: IG,
      link_data: { image_hash: a.imageHash, link: PDP, message: a.primary, name: a.headline, call_to_action: { type: "SHOP_NOW", value: { link: PDP } } },
    },
    url_tags: urlTags,
  };
  const p = new URLSearchParams();
  p.append("name", body.name);
  p.append("object_story_spec", JSON.stringify(body.object_story_spec));
  p.append("url_tags", body.url_tags);
  p.append("access_token", token);
  const r = await fetch(`${GB}/act_${ACCT}/adcreatives`, { method: "POST", body: p });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`creative: ${JSON.stringify(j.error || j)}`);
  return j.id as string;
}

const CONCEPTS: Record<string, { adset: string; file: string; name: string; headline: string; primary: string }> = {
  "concept-1": { adset: "120252196709210184", file: `${SCRATCH}/concept-1-4x5.jpg`, name: "MB R1 · skeptic v3",
    headline: "Mushroom Coffee Sounded Ridiculous…", primary: "…until the fog lifted and the cravings faded. 12 superfoods in every cup. Free shipping + up to 34% off." },
  "concept-2": { adset: "120252196930850184", file: `${SCRATCH}/concept-2-4x5.jpg`, name: "MB R1 · problem-pivot v3",
    headline: "Brain Fog & Afternoon Cravings?", primary: "Regular coffee = jitters then a crash. Amazing Coffee = sharper focus, fewer cravings, 12 superfoods in every cup. Free shipping + up to 34% off." },
  "concept-3": { adset: "120252196932390184", file: `${SCRATCH}/concept-3-4x5.jpg`, name: "MB R1 · ingredient-breakdown v3",
    headline: "One Cup. 12 Superfoods.", primary: "Green coffee, matcha, turmeric, cordyceps, maca & chaga — 12 superfoods working while you sip. Free shipping + up to 34% off." },
};

async function main() {
  const keys = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CONCEPTS);
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no token");
  const results: any[] = [];
  for (const k of keys) {
    const c = CONCEPTS[k];
    if (!c) { console.log(`unknown ${k}`); continue; }
    let bytes: Buffer;
    try { bytes = readFileSync(c.file); } catch { console.log(`SKIP ${k}: file missing`); results.push({ k, ok: false, reason: "file_missing" }); continue; }
    try {
      const imageHash = await uploadAdImage(token, ACCT, bytes, `${k}.jpg`);
      const creativeId = await createStaticCreative(token, { name: c.name, imageHash, headline: c.headline, primary: c.primary });
      const adId = await createAd(token, ACCT, { name: c.name, adsetId: c.adset, creativeId, status: "ACTIVE" });
      await updateObjectStatus(token, c.adset, "ACTIVE");
      console.log(`LIVE ${k}: ad=${adId} adset=${c.adset}`);
      results.push({ k, ok: true, adId });
    } catch (e: any) { console.log(`FAIL ${k}: ${e.message}`); results.push({ k, ok: false, reason: e.message }); }
  }
  if (results.some((r) => r.ok)) { await updateObjectStatus(token, CAMP, "ACTIVE"); console.log("CAMPAIGN ACTIVE"); }
  console.log("RESULT:", JSON.stringify(results));
}
main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e.message); process.exit(1); });
