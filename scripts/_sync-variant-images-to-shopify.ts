/**
 * Make Shopify's per-variant images match our own isolated cut-out shots.
 *
 *   npx tsx scripts/_sync-variant-images-to-shopify.ts           # dry run (default)
 *   npx tsx scripts/_sync-variant-images-to-shopify.ts --apply   # writes to Shopify
 *
 * Idempotent: media is matched by a deterministic alt marker, so a re-run after a
 * partial failure reuses what already uploaded. See [[shopify-variant-images]].
 */
import "./_bootstrap";
import { planVariantImageSync, applyVariantImageSync } from "../src/lib/shopify-variant-images";

const WS = process.env.WS || "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
const HTML = (() => { const i = process.argv.indexOf("--html"); return i > -1 ? process.argv[i + 1] : null; })();

const short = (u: string | null) => (u ? u.split("/").pop()!.split("?")[0].slice(0, 44) : "(none)");

(async () => {
  const plan = await planVariantImageSync(WS);

  console.log(`\n${plan.rows.length} variant(s) would change`);
  console.log(`  skipped, no isolated shot : ${plan.skippedNoIsolated}`);
  console.log(`  skipped, not on Shopify   : ${plan.skippedNoShopifyId}\n`);

  for (const r of plan.rows) {
    console.log(`  ${r.title.slice(0, 26).padEnd(28)} ${short(r.currentImageUrl).padEnd(46)} -> ${short(r.isolatedImageUrl)}`);
  }

  if (HTML) {
    // Filenames are all "isolated.png", so a list is unreviewable — render the
    // actual before/after pairs instead.
    const { writeFileSync } = await import("node:fs");
    const cards = plan.rows.map((r) => `
      <figure>
        <figcaption>${r.title}${r.sku ? ` <small>${r.sku}</small>` : ""}</figcaption>
        <div class="pair">
          <div><span>on Shopify now</span>${r.currentImageUrl ? `<img src="${r.currentImageUrl}" loading="lazy">` : `<div class="none">no image</div>`}</div>
          <div class="arrow">&rarr;</div>
          <div><span>isolated (ours)</span><img src="${r.isolatedImageUrl}" loading="lazy"></div>
        </div>
      </figure>`).join("");
    writeFileSync(HTML, `<!doctype html><meta charset="utf-8"><title>Variant image sync — ${plan.rows.length} changes</title>
<style>
 body{font:14px/1.5 system-ui;margin:0;padding:28px;background:#FBF1E9;color:#36181F}
 h1{font-size:22px;margin:0 0 4px} p.sub{color:#68424C;margin:0 0 24px}
 figure{margin:0 0 18px;background:#fff;border:1px solid #E2C6BE;border-radius:14px;padding:14px 16px}
 figcaption{font-weight:700;margin-bottom:10px}
 figcaption small{font-weight:400;color:#8A6670;margin-left:6px}
 .pair{display:flex;align-items:center;gap:18px}
 .pair>div{flex:0 0 auto;text-align:center}
 .pair span{display:block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#8A6670;margin-bottom:6px}
 .pair img{width:170px;height:170px;object-fit:contain;background:#F7F2ED;border-radius:10px}
 .none{width:170px;height:170px;display:grid;place-items:center;background:#F3E7E0;border-radius:10px;color:#8A6670}
 .arrow{font-size:26px;color:#C79A3A}
</style>
<h1>Variant image sync &mdash; ${plan.rows.length} changes</h1>
<p class="sub">Left is what Shopify shows today. Right is the isolated shot from our DB that would replace it.</p>
${cards}`);
    console.log(`\nwrote ${HTML}`);
  }

  if (!plan.rows.length) { console.log("\nnothing to do."); return; }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply to push these to Shopify.");
    return;
  }

  console.log("\napplying…\n");
  const outcomes = await applyVariantImageSync(WS, plan);
  for (const o of outcomes) {
    const mark = o.status === "failed" ? "FAIL" : o.status === "reused-media" ? "reuse" : "ok";
    console.log(`  ${mark.padEnd(6)} ${o.title.slice(0, 30).padEnd(32)} ${o.error || o.mediaId || ""}`);
  }
  const failed = outcomes.filter((o) => o.status === "failed").length;
  console.log(`\n${outcomes.length - failed} succeeded, ${failed} failed.`);
  if (failed) process.exitCode = 1;
})();
