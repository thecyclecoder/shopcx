/**
 * Stage 2 of the VIP-weekend graphic: composite the REAL isolated packshots
 * (`product_variants.isolated_image_url`) onto an AI-generated background plate
 * from `_gen-vip-plate.ts`.
 *
 * Why deterministic instead of a Nano Banana multi-image fusion: asked to fuse
 * six packshots, the model redesigns the packaging (wrong colors, wrong flavor
 * art, invented copy). Compositing keeps every pouch pixel-exact.
 *
 * Carries NO discount %, price, or amount — reusable for any VIP weekend.
 *
 * Read-only against the DB; writes the finished 2048x2048 PNGs to ~/Desktop.
 */
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import sharp from "sharp";
import "./_bootstrap";

const CANVAS = 2048;
const CACHE = join(
  "/private/tmp/claude-501/-Users-admin-Projects-shopcx/a9611f01-5e57-4883-8da5-a8ffb20aa4e9/scratchpad",
  "packshots",
);
const PLATES_DIR = join(
  "/private/tmp/claude-501/-Users-admin-Projects-shopcx/a9611f01-5e57-4883-8da5-a8ffb20aa4e9/scratchpad",
  "plates",
);

const BASE =
  "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906";

interface Shot {
  key: string;
  label: string;
  url: string;
  /** Source has no alpha (white studio background) → key it out by border flood-fill. */
  whiteBg?: boolean;
}

/** One hero packshot per product line. */
const SHOTS: Record<string, Shot> = {
  creamer: {
    key: "creamer",
    label: "Amazing Creamer — Salted Caramel",
    url: `${BASE}/61a4490e-cb2a-4f65-9613-faab40f0b153/variants/88d2df56-d99f-4eb6-8018-ba428bb415b6/isolated.png`,
  },
  coffee: {
    key: "coffee",
    label: "Amazing Coffee — Cocoa French Roast",
    url: `${BASE}/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png`,
  },
  focus: {
    key: "focus",
    label: "Ashwavana Guru Focus — Orange Passion Fruit",
    url: `${BASE}/f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb/variants/01eab80d-bf3d-4dea-9df4-1402518a32d0/isolated.png`,
  },
  zen: {
    key: "zen",
    label: "Ashwavana Zen Relax — Strawberry",
    url: `${BASE}/48bfa48c-b8db-42f9-9303-19c70ab8e7a1/variants/e3953a24-c060-41e7-9ca4-06a481df236b/isolated.png`,
  },
  creatine: {
    key: "creatine",
    label: "Creatine Prime+ — Black Cherry",
    url: `${BASE}/658f8c0c-944e-4744-a26a-51a484f788e8/variants/e8f03bcb-7b87-446e-8025-9af56f2ea1d4/isolated.png`,
    whiteBg: true,
  },
  tabs: {
    key: "tabs",
    label: "Superfood Tabs — Peach Mango",
    url: `${BASE}/221d272d-a6c5-4a5d-86ff-ac693926c992/variants/dc100894-76c9-4ad0-9e02-6012f35f5e1a/isolated.png`,
  },
};

/** Back row reads smaller + higher; front row is the hero line. */
const BACK_ROW = ["coffee", "tabs", "zen"];
const FRONT_ROW = ["focus", "creamer", "creatine"];

interface PlateSpec {
  slug: string;
  file: string;
  /** Baseline y (px) the row's products stand on. */
  backBaseline: number;
  frontBaseline: number;
  backHeight: number;
  frontHeight: number;
  /** Glossy plates get a mirrored reflection; matte plates get shadow only. */
  reflection: number; // 0 = off, else peak opacity 0..1
  shadowOpacity: number;
  /** Slight exposure match so cut-outs sit in the plate's light. */
  brightness: number;
}

const PLATE_SPECS: PlateSpec[] = [
  {
    slug: "vip-weekend-black-gold",
    file: "plate-black-gold.jpg",
    backBaseline: 1385,
    frontBaseline: 1840,
    backHeight: 545,
    frontHeight: 665,
    reflection: 0.16,
    shadowOpacity: 0.5,
    brightness: 0.97,
  },
  {
    slug: "vip-weekend-cream-editorial",
    file: "plate-cream-editorial.jpg",
    backBaseline: 1385,
    frontBaseline: 1840,
    backHeight: 545,
    frontHeight: 665,
    reflection: 0,
    shadowOpacity: 0.28,
    brightness: 1.0,
  },
  {
    slug: "vip-weekend-warm-spotlight",
    file: "plate-warm-spotlight.jpg",
    backBaseline: 1425,
    frontBaseline: 1855,
    backHeight: 535,
    frontHeight: 650,
    reflection: 0.14,
    shadowOpacity: 0.36,
    brightness: 1.0,
  },
];

// ── packshot prep ───────────────────────────────────────────────────────────

async function fetchShot(shot: Shot): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${shot.key}.png`);
  if (existsSync(path)) return path;
  const res = await fetch(shot.url);
  if (!res.ok) throw new Error(`image_fetch_${res.status} for ${shot.key}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

/**
 * Key out a white studio background by flood-filling inward from the border.
 * A global white threshold would punch holes through the white label band on
 * the pouch front, so only background-CONNECTED white is removed.
 */
async function keyWhiteBackground(input: Buffer): Promise<Buffer> {
  const img = sharp(input).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const isWhite = (i: number) => data[i] > 236 && data[i + 1] > 236 && data[i + 2] > 236;

  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (bg[p]) return;
    if (!isWhite(p * ch)) return;
    bg[p] = 1;
    stack.push(p);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  for (let p = 0; p < w * h; p++) if (bg[p]) data[p * ch + 3] = 0;

  // 1px alpha erode-ish feather: soften the hard key edge so the cut-out doesn't
  // carry a white fringe onto a dark plate.
  const out = await sharp(data, { raw: { width: w, height: h, channels: ch as 4 } })
    .png()
    .toBuffer();
  return out;
}

/** Fetch → key (if needed) → trim transparent margin → tight RGBA buffer. */
async function prepShot(shot: Shot): Promise<{ buffer: Buffer; width: number; height: number }> {
  const path = await fetchShot(shot);
  let buf = await sharp(path).png().toBuffer();
  if (shot.whiteBg) buf = await keyWhiteBackground(buf);
  const trimmed = await sharp(buf).ensureAlpha().trim({ threshold: 1 }).png().toBuffer();
  const meta = await sharp(trimmed).metadata();
  return { buffer: trimmed, width: meta.width!, height: meta.height! };
}

// ── scene elements ──────────────────────────────────────────────────────────

/** Soft elliptical contact shadow, pre-blurred, as its own RGBA layer. */
async function contactShadow(width: number, opacity: number): Promise<Buffer> {
  const w = Math.round(width * 1.05);
  const h = Math.round(width * 0.26);
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="g" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#000" stop-opacity="${opacity}"/>
      <stop offset="55%" stop-color="#000" stop-opacity="${opacity * 0.55}"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient></defs>
    <ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="url(#g)"/>
  </svg>`;
  return sharp(Buffer.from(svg)).blur(18).png().toBuffer();
}

/** Mirrored, vertically faded reflection of a product for glossy surfaces. */
async function reflection(product: Buffer, peak: number, maxHeight: number): Promise<Buffer> {
  const flipped = await sharp(product).flip().png().toBuffer();
  const { data, info } = await sharp(flipped)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  const fadeOver = Math.min(h, maxHeight);
  for (let y = 0; y < h; y++) {
    const t = y / fadeOver; // 0 at the contact point, 1 where it dies out
    const f = t >= 1 ? 0 : peak * Math.pow(1 - t, 2.2);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch + 3;
      data[i] = Math.round(data[i] * f);
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: ch as 4 } })
    .extract({ left: 0, top: 0, width: w, height: fadeOver })
    .png()
    .toBuffer();
}

// ── layout ──────────────────────────────────────────────────────────────────

interface Placed {
  buffer: Buffer;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Scale a row of packshots to a common height, then lay them out centered,
 * shrinking uniformly if the row would exceed its allowed width.
 */
async function layoutRow(
  keys: string[],
  prepped: Record<string, { buffer: Buffer; width: number; height: number }>,
  targetHeight: number,
  baseline: number,
  maxRowWidth: number,
  gap: number,
): Promise<Placed[]> {
  let scale = 1;
  const natural = keys.map((k) => {
    const p = prepped[k];
    const h = targetHeight;
    const w = Math.round((p.width / p.height) * h);
    return { k, w, h };
  });
  const total = natural.reduce((s, n) => s + n.w, 0) + gap * (keys.length - 1);
  if (total > maxRowWidth) scale = (maxRowWidth - gap * (keys.length - 1)) / (total - gap * (keys.length - 1));

  const sized = natural.map((n) => ({ ...n, w: Math.round(n.w * scale), h: Math.round(n.h * scale) }));
  const rowWidth = sized.reduce((s, n) => s + n.w, 0) + gap * (keys.length - 1);
  let x = Math.round((CANVAS - rowWidth) / 2);

  const out: Placed[] = [];
  for (const n of sized) {
    // The Amazing Coffee cut-out is only 500px square at source, so it lands
    // upscaled while the others downscale. Sharpen only when we're enlarging.
    const upscaled = n.w > prepped[n.k].width;
    let pipe = sharp(prepped[n.k].buffer).resize(n.w, n.h, { fit: "fill", kernel: "lanczos3" });
    if (upscaled) pipe = pipe.sharpen({ sigma: 1.1, m1: 0.6, m2: 0.4 });
    const buffer = await pipe.png().toBuffer();
    out.push({ buffer, left: x, top: baseline - n.h, width: n.w, height: n.h });
    x += n.w + gap;
  }
  return out;
}

// ── render ──────────────────────────────────────────────────────────────────

async function render(spec: PlateSpec, prepped: Record<string, any>, outDir: string) {
  const platePath = join(PLATES_DIR, spec.file);
  if (!existsSync(platePath)) {
    console.log(`  skip ${spec.slug}: plate missing (${spec.file}) — run _gen-vip-plate.ts first`);
    return;
  }

  // The back row sits higher AND smaller — correct table perspective, and it keeps
  // every brand name clear of the front row instead of half-hidden behind it.
  const back = await layoutRow(BACK_ROW, prepped, spec.backHeight, spec.backBaseline, 1660, 95);
  const front = await layoutRow(FRONT_ROW, prepped, spec.frontHeight, spec.frontBaseline, 1860, 30);

  const layers: sharp.OverlayOptions[] = [];

  // Back row: shadow → (reflection) → product. Front row composites after, so it
  // naturally occludes the base of the back row.
  for (const row of [back, front]) {
    const isFront = row === front;
    for (const p of row) {
      const shadow = await contactShadow(p.width, spec.shadowOpacity * (isFront ? 1 : 0.85));
      const sMeta = await sharp(shadow).metadata();
      layers.push({
        input: shadow,
        left: Math.round(p.left + p.width / 2 - sMeta.width! / 2),
        top: Math.round(p.top + p.height - sMeta.height! / 2),
      });
      if (spec.reflection > 0) {
        // Weaker + shorter on the back row: it is further up the table, so its
        // reflection should read as a hint of gloss, not a legible second copy.
        const peak = spec.reflection * (isFront ? 1 : 0.6);
        const refl = await reflection(p.buffer, peak, Math.round(p.height * (isFront ? 0.34 : 0.24)));
        layers.push({ input: refl, left: p.left, top: p.top + p.height });
      }
    }
    for (const p of row) {
      const tuned =
        spec.brightness === 1
          ? p.buffer
          : await sharp(p.buffer).modulate({ brightness: spec.brightness }).png().toBuffer();
      layers.push({ input: tuned, left: p.left, top: p.top });
    }
  }

  const plate = await sharp(platePath).resize(CANVAS, CANVAS, { fit: "cover" }).png().toBuffer();
  const png = await sharp(plate).composite(layers).png({ compressionLevel: 9 }).toBuffer();

  const outPng = join(outDir, `${spec.slug}.png`);
  writeFileSync(outPng, png);
  const outJpg = join(outDir, `${spec.slug}.jpg`);
  writeFileSync(outJpg, await sharp(png).jpeg({ quality: 92 }).toBuffer());
  console.log(`  ${spec.slug} → ${outPng} (${(png.length / 1024).toFixed(0)} KB) + .jpg`);
}

async function main() {
  const outDir = process.env.VIP_OUT_DIR || join(homedir(), "Desktop");
  mkdirSync(outDir, { recursive: true });

  console.log("prepping packshots…");
  const prepped: Record<string, any> = {};
  for (const key of [...BACK_ROW, ...FRONT_ROW]) {
    const p = await prepShot(SHOTS[key]);
    prepped[key] = p;
    console.log(`  ${key.padEnd(9)} ${p.width}x${p.height}  ${SHOTS[key].label}`);
  }

  console.log("rendering…");
  const only = process.argv[2];
  for (const spec of PLATE_SPECS) {
    if (only && spec.slug !== only) continue;
    await render(spec, prepped, outDir);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
