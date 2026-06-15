/**
 * Big-claim = contrarian/shock HOOK poster. Renders 3 directions at 4:5 so we
 * can pick the thumb-stopper, then the same 3 at 9:16. On-desire (weight/aging/
 * best-self), pattern-interrupt, compliant (no unrealistic numeric claims).
 *
 *   npx tsx scripts/render-bigclaim-options.ts
 */
import path from "path";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderStill } from "@remotion/renderer";

// Isolated (transparent-bg) bag — composites cleanly on the dark poster. NEVER product-on-white.
const PRODUCT_IMG = "https://urjbhjbygyxffrfkarqn.supabase.co/storage/v1/object/public/product-media/products/fdc11e10-b89f-4989-8b73-ed6526c4d906/ea433e56-0aa4-4b46-9107-feb11f77f533/variants/9ef9311d-57fa-426d-ad0f-250eaeabf122/isolated.png";
const baseProps = { accent: "#B0451C", productImageUrl: PRODUCT_IMG, productTitle: "Amazing Coffee", badges: ["Non-GMO", "3rd-Party Tested"], cta: "Shop now →" };

const VARIANTS = [
  { slug: "aging-enemy", eyebrow: "After 50, read this", hook: "Your coffee is aging you.", emphasis: "aging you",
    reveal: "This one fights back — 12 superfoods studied for antioxidants, weight, and firmer, younger-looking skin." },
  { slug: "stop-dieting", eyebrow: "Unpopular opinion", hook: "Stop dieting. Fix your coffee.", emphasis: "Fix your coffee.",
    reveal: "12 clinically studied superfoods for healthy weight — in the cup you already drink every morning." },
  { slug: "mushrooms", eyebrow: "Yes, you read that right", hook: "There are mushrooms in this coffee.", emphasis: "mushrooms",
    reveal: "Chaga, cordyceps & 10 more superfoods — for weight, energy and younger-looking skin. And it tastes incredible." },
];

const RATIOS = [
  { tag: "4x5", width: 1080, height: 1350, safeTopPct: 0, safeBottomPct: 0 },
  { tag: "9x16", width: 1080, height: 1920, safeTopPct: 0.08, safeBottomPct: 0.14 },
];

async function main() {
  const entry = path.resolve(process.cwd(), "remotion/index.ts");
  console.log("Bundling Remotion…");
  const serveUrl = await bundle({ entryPoint: entry });
  for (const v of VARIANTS) {
    for (const r of RATIOS) {
      const props = { ...baseProps, eyebrow: v.eyebrow, hook: v.hook, emphasis: v.emphasis, reveal: v.reveal, width: r.width, height: r.height, safeTopPct: r.safeTopPct, safeBottomPct: r.safeBottomPct };
      const composition = await selectComposition({ serveUrl, id: "StaticBigClaim", inputProps: props });
      const output = `/tmp/bigclaim-${v.slug}-${r.tag}.png`;
      console.log(`Rendering ${v.slug} ${r.tag}`);
      await renderStill({ composition, serveUrl, output, inputProps: props, frame: 0, overwrite: true });
    }
  }
  console.log("Done.");
}
main().catch((e) => { console.error(e); process.exit(1); });
