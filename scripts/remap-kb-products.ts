#!/usr/bin/env npx tsx
/**
 * Re-map KB articles to correct products using Claude AI
 * Run: npx tsx scripts/remap-kb-products.ts
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const admin = createClient(SUPABASE_URL, SUPABASE_KEY);

// Exclude non-sellable products
const EXCLUDE_PRODUCTS = ["Shipping Protection", "Mystery Item", "Bamboo Coffee Mug", "Handheld Drink Mixer", "Superfoods Tumbler"];

async function run() {
  // Get products (exclude accessories and shipping)
  const { data: allProducts } = await admin
    .from("products")
    .select("id, title")
    .eq("workspace_id", WORKSPACE_ID)
    .order("title");

  const products = (allProducts || []).filter(p => !EXCLUDE_PRODUCTS.includes(p.title));
  console.log(`${products.length} products (after excluding non-sellable):`);
  products.forEach(p => console.log(`  ${p.id} → ${p.title}`));

  // Get all KB articles
  const { data: articles } = await admin
    .from("knowledge_base")
    .select("id, title, content")
    .eq("workspace_id", WORKSPACE_ID)
    .order("title");

  console.log(`\n${(articles || []).length} articles to process`);

  const productList = products.map(p => `${p.id}|${p.title}`).join("\n");

  // Process in batches of 50
  const batches: typeof articles[] = [];
  for (let i = 0; i < (articles || []).length; i += 50) {
    batches.push((articles || []).slice(i, i + 50));
  }

  let updated = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    console.log(`\nProcessing batch ${batchIdx + 1}/${batches.length} (${batch.length} articles)...`);

    const articleList = batch.map((a, i) => {
      const contentPreview = (a.content || "").slice(0, 200).replace(/\n/g, " ");
      return `${i}|${a.id}|${a.title}|${contentPreview}`;
    }).join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        system: `You are matching knowledge base articles to the correct product.

Products:
${productList}
NONE|No specific product (general articles about the company, shipping, billing, etc.)

For each article, determine which product it's about based on the title and content preview.
- "Ashwavana" articles → match to the closest Ashwavana product (Guru Focus or Zen Relax). If the article is about Ashwavana generally (not specific to one), pick whichever is mentioned or default to Zen Relax.
- "ACV" or "Apple Cider Vinegar" → Apple Cider Vinegar Gummies
- "Coffee" or "brew" or "K-Cup" or "pod" → Amazing Coffee K-Cups (unless it says "creamer")
- "Creamer" → Amazing Creamer
- "Tabs" or "Superfood Tabs" or "drink tab" → Superfood Tabs
- "Sleep" or "melatonin" → Sleep Gummies
- "Creatine" → Creatine Prime+
- General company questions (shipping, returns, billing, loyalty, contact) → NONE

Return ONLY a JSON array of [index, product_id] pairs. Example: [[0,"abc-123"],[1,"NONE"],[2,"def-456"]]`,
        messages: [{ role: "user", content: `Match these articles to products:\n\n${articleList}` }],
      }),
    });

    if (!res.ok) {
      console.error(`  Claude API error: ${res.status}`);
      continue;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || "";

    let mappings: [number, string][];
    try {
      const match = text.match(/\[[\s\S]*\]/);
      mappings = match ? JSON.parse(match[0]) : [];
    } catch {
      console.error("  Failed to parse response");
      continue;
    }

    console.log(`  Got ${mappings.length} mappings`);

    for (const [idx, productId] of mappings) {
      const article = batch[idx];
      if (!article) continue;

      if (productId === "NONE") {
        // Clear product mapping
        await admin.from("knowledge_base").update({
          product_id: null,
          product_name: null,
          category: "general",
        }).eq("id", article.id);
        updated++;
      } else {
        const product = products.find(p => p.id === productId);
        if (product) {
          await admin.from("knowledge_base").update({
            product_id: product.id,
            product_name: product.title,
            category: "product",
          }).eq("id", article.id);
          updated++;
        }
      }
    }

    console.log(`  Updated ${mappings.length} articles`);

    // Rate limit
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nDone! Updated ${updated} articles.`);
}

run().catch(console.error);
