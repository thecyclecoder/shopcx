/**
 * seed-product-tools — the DETERMINISTIC tool CLI the `seed-product` skill calls
 * (box-product-seeding, corrected).
 *
 * The box's product-seed job runs a top-level `claude -p` on Max (web search,
 * no ANTHROPIC_API_KEY) executing the `seed-product` skill. That Claude does all
 * the REASONING (ingredient extraction, web-search research, review analysis,
 * benefit triangulation, content authoring, hero vision-QA) and reaches the
 * outside world ONLY through this CLI — PDP fetch, DB reads/writes, the Drive
 * service-account, the Gemini image API, publish. NO Anthropic API here.
 *
 * Contract: argv[2] = subcommand; remaining argv = positional args; some
 * subcommands read a JSON payload from STDIN. Every command prints exactly one
 * JSON object to STDOUT and exits 0 on success, or `{ "error": "…" }` + exit 1.
 *
 * Examples (run from the repo root):
 *   npx tsx scripts/seed-product-tools.ts product <ws> <pid>
 *   npx tsx scripts/seed-product-tools.ts fetch-pdp <handle>
 *   echo '[{"name":"Ashwagandha","dosage_display":"600mg"}]' | \
 *     npx tsx scripts/seed-product-tools.ts save-ingredients <ws> <pid>
 *
 * See docs/brain/specs/box-product-seeding.md + the seed-product skill.
 */
import "./_bootstrap"; // loads .env.local locally; no-op on the box (env from systemd)
import * as T from "../src/lib/product-intelligence/seed-tools";
import { errText } from "../src/lib/error-text";
import type { NanoBananaAspect } from "../src/lib/gemini";

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
  });
}

async function json<T = unknown>(): Promise<T> {
  const raw = (await readStdin()).trim();
  if (!raw) throw new Error("expected a JSON payload on stdin");
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`invalid JSON on stdin: ${errText(e)}`);
  }
}

async function jsonOptional<T = unknown>(fallback: T): Promise<T> {
  const raw = (await readStdin()).trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`invalid JSON on stdin: ${errText(e)}`);
  }
}

function out(value: unknown) {
  process.stdout.write(JSON.stringify(value));
  process.stdout.write("\n");
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const ws = rest[0];
  const pid = rest[1];

  switch (cmd) {
    case "product":
      return out(await T.getProduct(ws, pid));

    case "fetch-pdp":
      // fetch-pdp <handle>
      return out({ text: await T.fetchPdpText(rest[0]) });

    case "set-status":
      // set-status <ws> <pid> <status>
      return out(await T.setStatus(ws, pid, rest[2] as T.IntelligenceStatus));

    case "save-ingredients":
      return out(await T.saveIngredients(ws, pid, await json<T.ExtractedIngredient[]>()));

    case "get-ingredients":
      return out({ ingredients: await T.getIngredients(ws, pid) });

    case "save-research":
      return out(await T.saveResearch(ws, pid, await json<T.ResearchRow[]>()));

    case "get-research":
      return out({ research: await T.getResearch(ws, pid) });

    case "get-reviews": {
      // get-reviews <ws> <pid> [offset] [limit]
      const offset = rest[2] ? parseInt(rest[2], 10) : 0;
      const limit = rest[3] ? parseInt(rest[3], 10) : 100;
      return out(await T.getReviews(ws, pid, offset, limit));
    }

    case "save-review-analysis": {
      // payload: { analysis: {...}, reviews_analyzed: N }
      const p = await json<{ analysis: T.ReviewAnalysis; reviews_analyzed: number }>();
      return out(await T.saveReviewAnalysis(ws, pid, p.analysis || {}, p.reviews_analyzed || 0));
    }

    case "get-review-analysis":
      return out(await T.getReviewAnalysis(ws, pid));

    case "save-benefits":
      return out(await T.saveBenefits(ws, pid, await json<T.BenefitTheme[]>()));

    case "get-benefits":
      return out({ benefits: await T.getBenefits(ws, pid) });

    case "save-trust-pills":
      // save-trust-pills <ws> <pid> ← stdin { certifications?: string[], allergen_free?: string[] }
      // Writes products.certifications / allergen_free as INDIVIDUAL items (each
      // comma-joined element is split into separate pills).
      return out(await T.saveTrustPills(ws, pid, await json<{ certifications?: unknown; allergen_free?: unknown }>()));

    case "save-content":
      return out(await T.saveContent(ws, pid, await json<T.GeneratedContent>()));

    case "get-content":
      return out({ content: await T.getContent(ws, pid) });

    case "hero-status":
      // hero-status <ws> <pid> <handle>
      return out(await T.heroStatus(ws, pid, rest[2] || null));

    case "resolve-packshot": {
      // resolve-packshot <ws> <pid> "<productName>" "<comma,separated,variant,keywords>"
      const productName = rest[2] || "";
      const variantKeywords = (rest[3] || "").split(",").map((s) => s.trim()).filter(Boolean);
      return out(await T.resolvePackshot(ws, pid, productName, variantKeywords));
    }

    case "generate-image": {
      // payload: { prompt, imageUrls:[], slot, aspectRatio?, width?, height? }
      // For the hero pass aspectRatio "4:3" + width 1800 + height 1344 (the
      // landscape gallery size); the tool pads a near-aspect render to exact size.
      const p = await json<{
        prompt: string;
        imageUrls: string[];
        slot: string;
        aspectRatio?: NanoBananaAspect;
        width?: number;
        height?: number;
      }>();
      return out(await T.generateImage(ws, pid, p.prompt, p.imageUrls || [], p.slot || "hero", p.aspectRatio, p.width, p.height));
    }

    case "pull-ingredient-images":
      // pull-ingredient-images <ws> <pid> <handle> — real PDP CDN images → product_media slot=ingredient_{name}
      return out(await T.pullIngredientImages(ws, pid, rest[2]));

    case "ingredient-images-fallback":
      // ingredient-images-fallback <ws> <pid> ← optional stdin [{name,visual_description}]
      // FALLBACK after pull-ingredient-images: Nano Banana Pro studio photos ONLY
      // for ingredients still missing a pulled PDP image. PDP pull stays preferred.
      return out(await T.generateIngredientImagesFallback(ws, pid, await jsonOptional<T.IngredientFallbackInput[]>([])));

    case "get-media":
      // get-media <ws> <pid> — existing product_media slots (with urls) so the
      // skill knows which chapter images (lifestyle_1 / timeline_N) are missing.
      return out(await T.getMedia(ws, pid));

    case "save-media": {
      // payload: { slot, localPath, mimeType, altText, displayOrder? }
      // displayOrder > 0 saves a gallery row (e.g. extra slot="hero" slides).
      const p = await json<{ slot: string; localPath: string; mimeType: string; altText: string; displayOrder?: number }>();
      return out(await T.saveMedia(ws, pid, p.slot, p.localPath, p.mimeType, p.altText, p.displayOrder || 0));
    }

    case "pdp-images":
      // pdp-images <handle> — every Shopify-CDN image URL on the live PDP (for
      // the skill to pick endorsement avatars / before-after photos).
      return out(await T.getPdpImages(rest[0]));

    case "rehost-image": {
      // rehost-image <ws> <pid> ← stdin { sourceUrl, slot, displayOrder?, altText?, fit?, width?, height? }
      // Download a Shopify-CDN image + re-host to product-media (NEVER hotlink).
      const p = await json<{ sourceUrl: string; slot: string; displayOrder?: number; altText?: string; fit?: T.RehostFit; width?: number; height?: number }>();
      return out(await T.rehostImage(ws, pid, p.sourceUrl, p.slot, {
        displayOrder: p.displayOrder, altText: p.altText, fit: p.fit, width: p.width, height: p.height,
      }));
    }

    case "resolve-lifestyle": {
      // resolve-lifestyle <ws> <pid> "<productName>" "<kw1,kw2>" [pickIndex]
      // Drive UGC/Photos lifestyle slide → LOCAL file (vision-confirm, then save-media slot=hero displayOrder>0).
      const productName = rest[2] || "";
      const variantKeywords = (rest[3] || "").split(",").map((s) => s.trim()).filter(Boolean);
      const pickIndex = rest[4] ? parseInt(rest[4], 10) : 0;
      return out(await T.resolveLifestyleSlide(ws, pid, productName, variantKeywords, pickIndex));
    }

    case "generate-static-ad": {
      // generate-static-ad <ws> <pid> ← stdin { imageUrls:[packUrl,…], prompt, captions:[top,bottom] }
      // Nano-Banana Pro static-ad scene + caption overlays → LOCAL file (vision-confirm, then save-media slot=hero displayOrder>0).
      const p = await json<{ imageUrls: string[]; prompt: string; captions?: string[] }>();
      return out(await T.generateStaticAdSlide(ws, pid, p.imageUrls || [], p.prompt, p.captions || []));
    }

    case "publish":
      return out(await T.publish(ws, pid));

    default:
      throw new Error(
        `unknown subcommand: ${cmd || "(none)"}. See scripts/seed-product-tools.ts for the command list.`,
      );
  }
}

main().catch((e) => {
  out({ error: errText(e) });
  process.exit(1);
});
