/**
 * Import ONE Superfood Scoop article into posts (classify + migrate images +
 * upsert). Idempotent. Used by the blog-resources import workflow (one agent
 * per article) and runnable standalone.
 *
 *   npx tsx scripts/import-blog-article.ts <article-handle | shopify-article-id>
 */
import { readFileSync, existsSync } from "node:fs";
import { errText } from "../src/lib/error-text";
import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

async function main() {
  const target = process.argv[2];
  if (!target) { console.error(JSON.stringify({ error: "usage: import-blog-article <handle|id>" })); process.exit(1); }

  const { fetchBlogArticles, importBlogArticle } = await import("../src/lib/posts/import-article");
  const articles = await fetchBlogArticles(WORKSPACE_ID);
  const article = articles.find((a) => a.handle === target || a.shopifyArticleId === target || a.shopifyArticleId.endsWith(`/${target}`));
  if (!article) { console.error(JSON.stringify({ error: "article not found", target })); process.exit(1); }

  const r = await importBlogArticle(WORKSPACE_ID, article);
  console.log(JSON.stringify({
    ok: true,
    handle: article.handle,
    title: r.title,
    is_resource: r.is_resource,
    product_count: r.product_ids.length,
    grouping: r.grouping,
    images_migrated: r.imagesMigrated,
  }));
}
main().catch((e) => { console.error(JSON.stringify({ error: errText(e) })); process.exit(1); });
