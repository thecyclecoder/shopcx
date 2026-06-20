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
    throw new Error(`invalid JSON on stdin: ${e instanceof Error ? e.message : String(e)}`);
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

    case "save-media": {
      // payload: { slot, localPath, mimeType, altText }
      const p = await json<{ slot: string; localPath: string; mimeType: string; altText: string }>();
      return out(await T.saveMedia(ws, pid, p.slot, p.localPath, p.mimeType, p.altText));
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
  out({ error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
