/**
 * Backfill the proven "Amazing Coffee" example ad into the creative library so
 * it's a real, reusable campaign: face → avatar → campaign → talking/broll/music
 * ad_segments → composition → final ad_videos row. Idempotent (drops a prior
 * backfill campaign of the same name first). One-off; safe to delete after.
 *
 *   npx tsx scripts/backfill-example-ad.ts
 */
import { readFileSync } from "fs";

const envPath = "/Users/admin/Projects/shopcx/.env.local";
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("="); if (i < 0) continue;
  const k = t.slice(0, i); if (!process.env[k]) process.env[k] = t.slice(i + 1);
}

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BUILD = "/tmp/ad-build";
const DESK = "/Users/admin/Desktop";
const CAMPAIGN_NAME = "Amazing Coffee — UGC 40% Off (example)";
const LONG_TTL = 60 * 60 * 24 * 90; // 90 days — usable link for the live ad

(async () => {
  const { createAdminClient } = await import("/Users/admin/Projects/shopcx/src/lib/supabase/admin.ts");
  const { uploadBuffer, signedUrl } = await import("/Users/admin/Projects/shopcx/src/lib/ad-storage.ts");
  const admin = createAdminClient();

  // 1. Product — the "Amazing Coffee" bag (the angles target), not K-Cups.
  const { data: exact } = await admin.from("products").select("id, title").eq("workspace_id", WS).eq("title", "Amazing Coffee").limit(1).maybeSingle();
  const { data: prod } = exact
    ? { data: exact }
    : await admin.from("products").select("id, title").eq("workspace_id", WS).ilike("title", "%amazing coffee%").limit(1).maybeSingle();
  if (!prod) throw new Error("Amazing Coffee product not found");
  console.log("product:", prod.title, prod.id);

  // 1b. Drop any prior backfill (cascades segments + videos)
  const { data: prior } = await admin.from("ad_campaigns").select("id").eq("workspace_id", WS).eq("name", CAMPAIGN_NAME);
  for (const p of prior || []) { await admin.from("ad_campaigns").delete().eq("id", p.id); console.log("dropped prior campaign", p.id); }

  const upload = async (path: string, file: string, ct: string) => { await uploadBuffer(path, readFileSync(file), ct); };

  // 2. Face → face library (ad_avatar_candidates) + ad_avatars character
  const { data: cand } = await admin.from("ad_avatar_candidates").insert({
    workspace_id: WS, gender: "female", age_range: "35-44", health_level: "fit", ethnicity: "white",
    status: "available",
  }).select("id").single();
  const facePath = `avatars/${WS}/library/${cand!.id}.png`;
  await upload(facePath, `${DESK}/ad-avatar-face.png`, "image/png");
  await admin.from("ad_avatar_candidates").update({ storage_path: facePath }).eq("id", cand!.id);
  const faceUrl = await signedUrl(facePath, LONG_TTL);

  const { data: avatar } = await admin.from("ad_avatars").insert({
    workspace_id: WS, name: "Amazing Coffee UGC Woman (35-44, fit)", reference_image_urls: [facePath], status: "active",
  }).select("id").single();
  console.log("face → candidate", cand!.id, "avatar", avatar!.id);

  // 3. Campaign
  const fullScript = "If your coffee isn't helping you shed pounds and fight aging, you're drinking the wrong one. Amazing Coffee is twelve superfoods in one cup. It curbs cravings and gives clean energy, no crash. Visit our website for up to forty percent off and free shipping, but only for a limited time.";
  const { data: camp } = await admin.from("ad_campaigns").insert({
    workspace_id: WS, name: CAMPAIGN_NAME, product_id: prod.id, avatar_id: avatar!.id,
    script_text: fullScript, length_sec: 22, caption_style: "hormozi_yellow", vibe_tags: ["ugc"], status: "ready",
  }).select("id").single();
  const campaignId = camp!.id;
  console.log("campaign:", campaignId);

  // 3b. Hero (holding product, Nano Banana Pro)
  const heroPath = `avatars/${WS}/heroes/${campaignId}.png`;
  await upload(heroPath, `${DESK}/ad-holding-product-nbp.png`, "image/png");
  const heroUrl = await signedUrl(heroPath, LONG_TTL);
  await admin.from("ad_campaigns").update({ hero_image_url: heroUrl }).eq("id", campaignId);

  // 4. Talking-head segments (Veo 3.1 Fast) — with the exact script + whisper + trim
  const manifest = JSON.parse(readFileSync(`${BUILD}/manifest.json`, "utf8")) as Array<{ text: string; words: any[]; trimSec: number }>;
  const segIds: string[] = [];
  let acc = 0;
  const segMeta: { id: string; startSec: number; trimSec: number }[] = [];
  const allWords: any[] = [];
  for (let i = 0; i < manifest.length; i++) {
    const m = manifest[i];
    const path = `talking-head/${WS}/${campaignId}_${i}.mp4`;
    await upload(path, `${BUILD}/seg${i}.mp4`, "video/mp4");
    const lastEnd = m.words?.length ? m.words[m.words.length - 1].end : m.trimSec;
    const { data: seg } = await admin.from("ad_segments").insert({
      workspace_id: WS, campaign_id: campaignId, kind: "talking_head", seq: i, version: 1, is_active: true,
      script_text: m.text, model: "veo-3.1-fast-generate-preview",
      prompt: `UGC selfie, woman holding Amazing Coffee, says ONLY: "${m.text}"`,
      storage_path: path, duration_sec: Number(lastEnd.toFixed(2)), trim_sec: Number(m.trimSec.toFixed(2)),
      transcript_json: { words: m.words }, status: "ready",
    }).select("id").single();
    segIds.push(seg!.id);
    segMeta.push({ id: seg!.id, startSec: acc, trimSec: Number(m.trimSec.toFixed(2)) });
    for (const w of m.words) allWords.push({ word: w.word, start: w.start + acc, end: w.end + acc });
    acc += Number(m.trimSec.toFixed(2));
  }
  const durationSec = Number(acc.toFixed(2));
  console.log("talking segments:", segIds.length, "| duration", durationSec);

  // 5. B-roll (muted/ASMR cutaways): ingredients + asmr
  const brollFiles = [
    { file: `${BUILD === "x" ? "" : "/Users/admin/Projects/shopcx/remotion/public/adbuild"}/broll-ingredients.mp4`, model: "dop:ingredients" },
    { file: `${BUILD}/broll-asmr.mp4`, model: "veo-3.1-fast-asmr" },
  ];
  const brollIds: string[] = [];
  for (let i = 0; i < brollFiles.length; i++) {
    const path = `broll/${WS}/${campaignId}_${i}.mp4`;
    await upload(path, brollFiles[i].file, "video/mp4");
    const { data: b } = await admin.from("ad_segments").insert({
      workspace_id: WS, campaign_id: campaignId, kind: "broll", seq: i, version: 1, is_active: true,
      model: brollFiles[i].model, prompt: i === 0 ? "ASMR ingredient/lifestyle cutaway" : "ASMR coffee pour, no music",
      storage_path: path, status: "ready",
    }).select("id").single();
    brollIds.push(b!.id);
  }
  console.log("broll segments:", brollIds.length);

  // 6. Music bed (Lyria)
  const musicPath = `audio/${WS}/${campaignId}_music.mp3`;
  await upload(musicPath, `${BUILD}/music.mpeg`, "audio/mpeg");
  const { data: music } = await admin.from("ad_segments").insert({
    workspace_id: WS, campaign_id: campaignId, kind: "music", seq: 0, version: 1, is_active: true,
    model: "lyria-3-clip-preview", prompt: "Upbeat uplifting instrumental bed, light acoustic guitar + soft claps, no vocals, loopable",
    storage_path: musicPath, status: "ready",
  }).select("id").single();

  // 7. Composition — the exact approved stitch (so a re-render reproduces it)
  const start1 = segMeta[1].startSec;
  const composition = {
    segments: segMeta.map((s) => ({ segment_id: s.id, startSec: s.startSec, trimSec: s.trimSec })),
    broll: [
      { segment_id: brollIds[0], fromSec: Number((start1 + 0.6).toFixed(2)), durSec: 2.2, volume: 0.18 },
      { segment_id: brollIds[1], fromSec: Number((start1 + 3.2).toFixed(2)), durSec: 2.6, volume: 0.2 },
    ],
    music: { segment_id: music!.id, volume: 0.12 },
    durationSec, fps: 30,
  };
  await admin.from("ad_campaigns").update({ composition }).eq("id", campaignId);

  // 8. Final rendered ad → ad_videos (reels 9:16)
  const { data: vid } = await admin.from("ad_videos").insert({
    workspace_id: WS, campaign_id: campaignId, format: "reels_9x16", media_kind: "video",
    caption_style: "hormozi_yellow", duration_sec: Math.round(durationSec),
    transcript_json: { words: allWords }, status: "ready",
  }).select("id").single();
  const finalPath = `finals/${WS}/${vid!.id}.mp4`;
  await upload(finalPath, `${BUILD}/final.mp4`, "video/mp4");
  const finalUrl = await signedUrl(finalPath, LONG_TTL);
  await admin.from("ad_videos").update({ final_mp4_url: finalUrl, meta: { storage_path: finalPath, source: "example-backfill" } }).eq("id", vid!.id);

  // 9. Enable the ad tool for this workspace so it's visible/usable
  await admin.from("workspaces").update({ ad_tool_enabled: true }).eq("id", WS);

  console.log("\n✓ creative library entry created");
  console.log("  campaign  :", campaignId);
  console.log("  face      :", faceUrl.slice(0, 80) + "…");
  console.log("  hero      :", heroUrl.slice(0, 80) + "…");
  console.log("  final ad  :", finalUrl.slice(0, 80) + "…");
  console.log("  segments  :", segIds.length, "talking +", brollIds.length, "broll + 1 music");
})().catch((e) => { console.error("BACKFILL ERR", e); process.exit(1); });
