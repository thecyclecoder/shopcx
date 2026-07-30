/**
 * One-off: generate a 1:1 VIP Weekend Sale graphic from the real isolated
 * packshots in `product_variants.isolated_image_url` (Nano Banana Pro fusion).
 *
 * Deliberately carries NO discount %, price, or dollar amount so the same
 * graphic is reusable across every VIP weekend.
 *
 * Read-only against the DB; writes the rendered PNGs to ~/Desktop.
 */
import { writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import "./_bootstrap";
import { generateNanoBananaProCombine } from "../src/lib/gemini";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const BASE =
  "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906";

// One hero packshot per product line (6 lines), in the order referenced by the prompts.
const PACKSHOTS = [
  `${BASE}/61a4490e-cb2a-4f65-9613-faab40f0b153/variants/88d2df56-d99f-4eb6-8018-ba428bb415b6/isolated.png`, // 1 Amazing Creamer — Salted Caramel
  `${BASE}/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png`, // 2 Amazing Coffee — Cocoa French Roast
  `${BASE}/f55a1cb1-f3ca-4e0d-9c64-ecd1cd865efb/variants/01eab80d-bf3d-4dea-9df4-1402518a32d0/isolated.png`, // 3 Ashwavana Guru Focus — Orange Passion Fruit
  `${BASE}/48bfa48c-b8db-42f9-9303-19c70ab8e7a1/variants/e3953a24-c060-41e7-9ca4-06a481df236b/isolated.png`, // 4 Ashwavana Zen Relax — Strawberry
  `${BASE}/658f8c0c-944e-4744-a26a-51a484f788e8/variants/e8f03bcb-7b87-446e-8025-9af56f2ea1d4/isolated.png`, // 5 Creatine Prime+ — Black Cherry
  `${BASE}/221d272d-a6c5-4a5d-86ff-ac693926c992/variants/dc100894-76c9-4ad0-9e02-6012f35f5e1a/isolated.png`, // 6 Superfood Tabs — Peach Mango
];

/** Shared constraints — the parts that must be true of every concept. */
const RULES = `
HARD RULES — follow every one:
- Reproduce all SIX supplied product packages EXACTLY as given: same artwork, same colors, same logos, same wording, same proportions. Do NOT redesign, recolor, restyle, relabel, or invent packaging. Do NOT swap flavors or fruit imagery. Treat each package as a photograph to be composited, not a design to be reinterpreted.
- Every package must be fully visible, upright, front-facing, unobstructed and readable. No package cropped by the frame edge. No package hidden behind another by more than a small overlap.
- The ONLY text you may render is the headline text specified below. Render it with perfect, correctly-spelled, professionally kerned lettering.
- ABSOLUTELY NO numbers, percentages, prices, dollar signs, dates, "% OFF", "SAVE", or any discount figure anywhere in the image. The graphic must stay reusable for any future sale.
- No people, no hands, no faces, no body parts.
- No fake awards, no fake review stars, no fake certification badges, no invented brand marks.
- Square 1:1 composition, balanced, generous margins, safe for a social feed and an email header.
- Photorealistic commercial product photography: crisp studio lighting, soft realistic contact shadows, believable reflections, high-end CPG ecommerce finish.
`.trim();

const CONCEPTS: { slug: string; prompt: string }[] = [
  {
    slug: "vip-weekend-black-gold",
    prompt: `Create a premium 1:1 square VIP sale graphic for a supplement brand, using the six supplied product packages.

SCENE: A luxurious dark studio set. Deep charcoal-to-black gradient backdrop with a subtle warm golden glow radiating from behind the products. The six packages stand together in a confident retail hero cluster on a glossy black reflective surface — a taller back row of three, a front row of three slightly forward and lower, staggered so all six faces read clearly. Soft golden rim-light traces the edge of each package and separates it from the dark background. Elegant, restrained gold light streaks in the upper background. A few fine, sparse gold particles floating in the air — tasteful, not confetti spam.

HEADLINE: Across the upper area, on the dark backdrop above the products, set the words "VIP WEEKEND" as the dominant headline in a bold, wide, condensed uppercase sans-serif with a brushed metallic gold finish, and directly beneath it the single word "SALE" in a smaller letter-spaced uppercase gold serif. Nothing else. Center-aligned. Leave clear breathing room between the headline and the tops of the packages.

MOOD: exclusive, members-only, premium, expensive.

${RULES}`,
  },
  {
    slug: "vip-weekend-cream-editorial",
    prompt: `Create a clean, modern, editorial 1:1 square VIP sale graphic for a supplement brand, using the six supplied product packages.

SCENE: A bright premium studio set. Soft warm cream / off-white seamless backdrop with a very subtle radial warm glow behind the products. The six packages stand in a relaxed hero cluster on a matte cream surface — staggered depth, a couple slightly turned, all six front faces clearly readable. Soft natural daylight from the upper left, gentle realistic contact shadows pooling under each package. Behind the cluster, one large flat circle of soft muted terracotta as a background shape, sitting behind the products like a modern editorial backdrop. Thin elegant gold hairline border inset from the edge of the square frame.

HEADLINE: In the upper third, on the clean backdrop above the products, set "VIP WEEKEND" in a large bold uppercase sans-serif in deep charcoal, and directly beneath it "SALE" in a smaller, widely letter-spaced uppercase in warm gold. Nothing else. Center-aligned, with clear space between the headline and the packages.

MOOD: clean, premium, calm, aspirational, DTC wellness brand.

${RULES}`,
  },
  {
    slug: "vip-weekend-warm-spotlight",
    prompt: `Create a bold, high-impact 1:1 square VIP sale graphic for a supplement brand, using the six supplied product packages.

SCENE: A dramatic warm studio set. Rich burnt-orange to deep amber gradient backdrop with a bright soft spotlight pool centered behind the products, falling off to darker warm corners for vignette. The six packages are arranged in a tight, powerful pyramid cluster standing on a subtly reflective warm surface — three across the back slightly elevated, three across the front, all staggered so every front face is fully visible and readable. Strong directional key light from above front, crisp realistic shadows raking back. A soft glowing halo ring of light behind the cluster. Subtle warm lens bloom.

HEADLINE: In the top area on the gradient backdrop, set "VIP WEEKEND" in a very bold heavy uppercase condensed sans-serif in clean white, with the single word "SALE" directly beneath it in a smaller widely letter-spaced uppercase in soft cream. Nothing else. Center-aligned, with generous clear space above the products.

MOOD: energetic, urgent, retail-hero, scroll-stopping on a social feed.

${RULES}`,
  },
];

async function main() {
  const outDir = join(homedir(), "Desktop");
  const only = process.argv[2];
  const targets = only ? CONCEPTS.filter((c) => c.slug === only) : CONCEPTS;
  if (!targets.length) throw new Error(`no concept matching "${only}"`);

  for (const c of targets) {
    process.stdout.write(`generating ${c.slug} … `);
    try {
      const { buffer, mimeType } = await generateNanoBananaProCombine({
        workspaceId: WORKSPACE_ID,
        prompt: c.prompt,
        imageUrls: PACKSHOTS,
        aspectRatio: "1:1",
      });
      const ext = mimeType.includes("jpeg") ? "jpg" : "png";
      const path = join(outDir, `${c.slug}.${ext}`);
      writeFileSync(path, buffer);
      console.log(`ok → ${path} (${(buffer.length / 1024).toFixed(0)} KB)`);
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
