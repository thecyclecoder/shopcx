import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { resolve } from "path";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";

const ROOT = "/Users/admin/Projects/shopcx";
const PUB = ROOT + "/remotion/public/adbuild";
const FPS = 30;
const EMPH = /pound|aging|wrong|free|shipping|superfood|energy|crash|forty|40|percent|limited|craving|shed|website|\d/i;
// Map spelled-out numbers to digits so the script ("twelve") aligns with what
// Whisper transcribes ("12") — otherwise numbers get dropped as "filler".
const NUMWORDS: Record<string,string> = { zero:"0",one:"1",two:"2",three:"3",four:"4",five:"5",six:"6",seven:"7",eight:"8",nine:"9",ten:"10",eleven:"11",twelve:"12",thirteen:"13",fourteen:"14",fifteen:"15",sixteen:"16",seventeen:"17",eighteen:"18",nineteen:"19",twenty:"20",thirty:"30",forty:"40",fifty:"50",sixty:"60",seventy:"70",eighty:"80",ninety:"90",hundred:"100" };
const norm = (s:string)=> { let n=(s||"").toLowerCase().replace(/[^a-z0-9%]/g,""); if (NUMWORDS[n]!==undefined) n=NUMWORDS[n]; return n; };

// Drop Veo's hallucinated filler words from the CAPTIONS (audio keeps them):
// align Whisper words to the intended script, keep only words that match the
// script sequence, drop extras (and anything after the script is exhausted).
function proofread(scriptText:string, words:any[]) {
  const tokens = scriptText.split(/\s+/).map(norm).filter(Boolean);
  if (!tokens.length) return words;
  const out:any[] = []; let ti = 0;
  // If the just-matched word is a number and the NEXT script token is "percent",
  // show "N%" on the number's beat (Whisper often drops/garbles "percent").
  const attachPercent = (pushed:any) => {
    if (ti < tokens.length && (tokens[ti]==="percent" || tokens[ti]==="%")) {
      const digits = (pushed.word.match(/\d+/)||[])[0];
      if (digits) { pushed.word = digits + "%"; ti++; }
    }
  };
  for (const w of words) {
    const nw = norm(w.word); if (!nw) continue;
    if (ti >= tokens.length) break; // script done → trailing words are filler
    if (nw === tokens[ti] || tokens[ti].includes(nw) || nw.includes(tokens[ti])) { const p={...w}; ti++; attachPercent(p); out.push(p); continue; }
    // small look-ahead in case Whisper dropped a script word
    let found = -1;
    for (let k=ti+1; k<Math.min(ti+3, tokens.length); k++) if (nw === tokens[k]) { found = k; break; }
    if (found >= 0) { const p={...w}; ti = found + 1; attachPercent(p); out.push(p); }
    // else: not in script → filler, drop from captions
  }
  return out;
}

function groupCaptions(words:any[]) {
  const groups:any[] = []; let i = 0, gi = 0;
  while (i < words.length) {
    const clean = (words[i].word||"").replace(/[^a-z0-9%]/gi, "");
    let take = clean.length <= 4 ? 1 : 2;
    const next = words[i+1]?.word?.trim()?.toLowerCase();
    if (["up","off","in","on"].includes(next)) take = 2;
    take = Math.min(take, words.length - i);
    const slice = words.slice(i, i + take);
    const text = slice.map((s:any)=>s.word.trim()).join(" ").replace(/[",.]/g,"").trim();
    const emphasis = slice.some((s:any)=>EMPH.test(s.word));
    const baseColor = Math.floor(gi/3)%2===1 ? "white" : "yellow";
    groups.push({ text, start: slice[0].start, end: slice[slice.length-1].end, color: emphasis?"yellow":baseColor, emphasis });
    i += take; gi++;
  }
  // Non-overlap: each caption shows until the NEXT one starts (no stacking, no gap).
  for (let g=0; g<groups.length-1; g++) groups[g].end = groups[g+1].start;
  if (groups.length) groups[groups.length-1].end += 0.4;
  return groups;
}

(async()=>{
  const manifest = JSON.parse(readFileSync("/tmp/ad-build/manifest.json","utf8"));
  // stage latest assets into public dir
  for (let i=0;i<manifest.length;i++) copyFileSync(manifest[i].file, `${PUB}/seg${i}.mp4`);
  for (const f of ["broll-asmr.mp4","music.mp3","broll-ingredients.mp4"]) if (existsSync(`/tmp/ad-build/${f.replace("music.mp3","music.mpeg")}`)) {}
  copyFileSync("/tmp/ad-build/broll-asmr.mp4", `${PUB}/broll-asmr.mp4`);
  copyFileSync("/tmp/ad-build/music.mpeg", `${PUB}/music.mp3`);

  // timeline
  let acc = 0; const segments:any[] = []; const allWords:any[] = [];
  for (let i=0;i<manifest.length;i++){
    const m = manifest[i]; segments.push({ src:`adbuild/seg${i}.mp4`, startSec: acc, trimSec: m.trimSec });
    const clean = proofread(m.text || "", m.words); // drop Veo filler from captions
    for (const w of clean) allWords.push({ word:w.word, start:w.start+acc, end:w.end+acc });
    acc += m.trimSec;
  }
  const durationSec = acc;
  const captions = groupCaptions(allWords);
  const start1 = segments[1]?.startSec ?? 0;
  const broll = [
    { src:"adbuild/broll-ingredients.mp4", fromSec: start1+0.6, durSec: 2.2, volume: 0.18 },
    { src:"adbuild/broll-asmr.mp4", fromSec: start1+3.2, durSec: 2.6, volume: 0.20 },
  ].filter(b=>existsSync(`${PUB}/${b.src.split("/")[1]}`));

  const inputProps = { width:1080, height:1920, fps:FPS, durationSec, segments, broll, music:{ src:"adbuild/music.mp3", volume:0.12 }, captions };
  console.log(`duration ${durationSec.toFixed(1)}s | ${captions.length} caption beats | ${broll.length} b-roll overlays`);

  console.log("bundling...");
  const serveUrl = await bundle({ entryPoint: resolve(ROOT,"remotion/index.ts"), publicDir: resolve(ROOT,"remotion/public") });
  const composition = await selectComposition({ serveUrl, id:"ExampleAd", inputProps });
  console.log("rendering...");
  const out = "/tmp/ad-build/final.mp4";
  await renderMedia({ composition, serveUrl, codec:"h264", outputLocation: out, inputProps });
  copyFileSync(out, "/Users/admin/Desktop/ad-EXAMPLE-FINAL.mp4");
  console.log("✓ ~/Desktop/ad-EXAMPLE-FINAL.mp4");
})().catch(e=>{ console.error("RENDER ERR", e.message); process.exit(1); });
