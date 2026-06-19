/**
 * PDP ingredient auto-extraction (box-product-seeding step 1).
 *
 * The live storefront renders a "Clinically Studied Ingredients" chapter as
 * server-side HTML at superfoodscompany.com/products/{handle} (verified
 * 2026-06-19 for Ashwavana Guru Focus — 18 ingredients + descriptions). We
 * fetch that page, strip it to text, and have Sonnet pull the ingredient
 * names + dosages → `product_ingredients`. No headless browser needed.
 *
 * Manual entry in the Engine UI still works when no chapter exists — this only
 * runs when the box has near-zero input (just a handle).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { callSonnet, extractJson } from "./engine";

type Admin = ReturnType<typeof createAdminClient>;

const STOREFRONT_BASE = process.env.SUPERFOODS_STOREFRONT_BASE || "https://superfoodscompany.com";

export type ExtractedIngredient = { name: string; dosage_display: string | null };

/** Fetch the PDP HTML and reduce it to readable text (scripts/styles/tags stripped). */
export async function fetchPdpText(handle: string): Promise<string | null> {
  const url = `${STOREFRONT_BASE}/products/${handle}`;
  const res = await fetch(url, { headers: { "User-Agent": "ShopCX-box/1.0 (+product-seeding)" } });
  if (!res.ok) return null;
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  // Cap to keep the Sonnet prompt bounded — the ingredient chapter sits well
  // within the first ~60k chars of rendered copy.
  return text.slice(0, 60000);
}

/** Ask Sonnet to pull the clinically-studied ingredient list (name + dosage) from PDP text. */
export async function extractIngredientsFromPdp(handle: string): Promise<ExtractedIngredient[]> {
  const text = await fetchPdpText(handle);
  if (!text) return [];
  const system = `You extract supplement ingredient facts from product page copy. Respond with strict JSON only — no prose, no markdown fences.`;
  const user = `Below is the rendered text of a product page. Find the clinically-studied / key ingredients section (it may be titled "Clinically Studied Ingredients", "Key Ingredients", "What's Inside", "Supplement Facts", etc.).

Return a JSON array of the active functional ingredients, in the order they appear, each as:
{ "name": "ingredient name (no dosage in the name)", "dosage_display": "the amount with units e.g. '600mg', '5g', '10 billion CFU', or null if none is stated" }

Rules:
- Only real functional/active ingredients. Skip generic "other ingredients", flavorings, anti-caking agents, and marketing words.
- Do NOT invent dosages — use null when the page doesn't state one.
- If there is no ingredient section at all, return [].

PRODUCT PAGE TEXT:
${text}`;
  const resp = await callSonnet(system, user, 4096, 0);
  if (!resp) return [];
  const parsed = extractJson<ExtractedIngredient[] | { ingredients: ExtractedIngredient[] }>(resp.text);
  const list: ExtractedIngredient[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "ingredients" in parsed && Array.isArray(parsed.ingredients)
      ? parsed.ingredients
      : [];
  return list
    .filter((i) => i && typeof i.name === "string" && i.name.trim())
    .map((i) => ({ name: i.name.trim(), dosage_display: i.dosage_display?.trim() || null }));
}

/**
 * Extract + persist ingredients for a product. Idempotent: if the product
 * already has ingredients we DON'T clobber them (manual entry / a prior run
 * wins). Returns the count present after the step.
 */
export async function seedIngredientsFromPdp(
  admin: Admin,
  args: { workspace_id: string; product_id: string; handle: string },
): Promise<{ added: number; existing: number; extracted: number }> {
  const { workspace_id, product_id, handle } = args;

  const { data: existing } = await admin
    .from("product_ingredients")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id);
  const existingCount = existing?.length || 0;
  if (existingCount > 0) {
    return { added: 0, existing: existingCount, extracted: 0 };
  }

  const extracted = await extractIngredientsFromPdp(handle);
  if (extracted.length === 0) return { added: 0, existing: 0, extracted: 0 };

  const rows = extracted.map((ing, i) => ({
    workspace_id,
    product_id,
    name: ing.name,
    dosage_display: ing.dosage_display,
    display_order: i,
  }));
  const { error } = await admin.from("product_ingredients").insert(rows);
  if (error) throw new Error(`ingredient_insert: ${error.message}`);

  return { added: rows.length, existing: 0, extracted: extracted.length };
}
