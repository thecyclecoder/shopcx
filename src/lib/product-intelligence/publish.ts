/**
 * Publish a product's generated page content (shared by the Engine UI route and
 * the box seed pipeline). Creates support macros (inactive), upserts the KB
 * article, flips `product_page_content.status='published'` and
 * `products.intelligence_status='published'`. Reuse, never fork.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

type SupportMacro = { title: string; body_text: string; body_html?: string; question_type: string };

/**
 * Structural shape of a variant's `supplement_facts` JSONB. Mirrors
 * `SupplementFacts` in the storefront page-data, kept structural here so server
 * libs (publish, the orchestrator nutrition tool) can format facts without
 * importing storefront code.
 */
export interface SupplementFactsShape {
  serving_size?: string;
  servings_per_container?: number;
  nutrients?: Array<{ name: string; amount: string; daily_value: string | null; indent?: number }>;
  proprietary_blend?: { amount: string; daily_value: string; ingredients: string } | null;
  footer_notes?: string[];
  other_ingredients?: string | null;
}

/**
 * Render a variant's Supplement Facts as plain readable text — for the KB
 * mirror (so the AI can retrieve nutrition) and the orchestrator nutrition
 * tool. Returns "" for empty/missing facts so callers can skip cleanly (no
 * nutrition is ever surfaced until a variant's facts are actually populated +
 * founder-verified). Plain text, no markdown table — RAG chunks read better flat.
 */
export function formatSupplementFactsText(facts: SupplementFactsShape | null | undefined): string {
  if (!facts) return "";
  const lines: string[] = [];
  if (facts.serving_size) lines.push(`Serving size: ${facts.serving_size}`);
  if (facts.servings_per_container != null) lines.push(`Servings per container: ${facts.servings_per_container}`);
  for (const n of facts.nutrients || []) {
    const pad = n.indent ? "  ".repeat(n.indent) : "";
    const dv = n.daily_value ? ` (${n.daily_value})` : "";
    lines.push(`${pad}- ${n.name}: ${n.amount}${dv}`);
  }
  if (facts.proprietary_blend) {
    const pb = facts.proprietary_blend;
    lines.push(`- Proprietary blend: ${pb.amount}${pb.daily_value ? ` (${pb.daily_value})` : ""}`);
    if (pb.ingredients) lines.push(`  ${pb.ingredients}`);
  }
  if (facts.other_ingredients) lines.push(`Other ingredients: ${facts.other_ingredients}`);
  for (const f of facts.footer_notes || []) lines.push(f);
  return lines.join("\n").trim();
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

export async function publishProductContent(
  admin: Admin,
  args: { workspace_id: string; product_id: string; contentId: string },
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const { workspace_id, product_id, contentId } = args;

  const { data: content } = await admin
    .from("product_page_content")
    .select("*")
    .eq("id", contentId)
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .single();
  if (!content) return { ok: false, error: "Not found", status: 404 };

  // Block publishing if "what it doesn't do" is empty (DSHEA honesty rail).
  if (!content.kb_what_it_doesnt_do || !content.kb_what_it_doesnt_do.trim()) {
    return { ok: false, error: "Cannot publish: 'What it doesn't do' section is required.", status: 400 };
  }

  const { data: product } = await admin
    .from("products")
    .select("id, title")
    .eq("id", product_id)
    .eq("workspace_id", workspace_id)
    .single();
  if (!product) return { ok: false, error: "Product not found", status: 404 };

  // Macros (inactive by default — editorial review in macros settings).
  const macros = (content.support_macros as SupportMacro[]) || [];
  for (const m of macros) {
    if (!m?.title || !m?.body_text) continue;
    await admin.from("macros").insert({
      workspace_id,
      name: m.title,
      body_text: m.body_text,
      body_html: m.body_html || null,
      category: "product",
      tags: ["product-intelligence", `qtype:${m.question_type || "general"}`],
      active: false,
    });
  }

  // Per-variant Supplement Facts → KB mirror. Only variants whose
  // `supplement_facts` is actually populated contribute a block, so a product
  // with no (verified) facts adds nothing — nutrition never ships to the KB
  // until the facts exist. Gives the support AI retrievable nutrition (sodium,
  // potassium, caffeine, calories, etc.) so it can answer per-flavor on a ticket.
  const { data: factVariants } = await admin
    .from("product_variants")
    .select("title, option1, position, supplement_facts")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .not("supplement_facts", "is", null)
    .order("position", { ascending: true });
  const factsBlocks: string[] = [];
  for (const v of factVariants || []) {
    const txt = formatSupplementFactsText(v.supplement_facts as SupplementFactsShape | null);
    if (!txt) continue;
    const label = ((v.title || v.option1 || "Supplement Facts") as string).trim();
    factsBlocks.push(`### ${label}\n${txt}`);
  }

  // KB article.
  const articleBody = [
    content.knowledge_base_article || "",
    "",
    "## What this product does not do",
    "",
    content.kb_what_it_doesnt_do || "",
    ...(factsBlocks.length ? ["", "## Supplement Facts (per variant)", "", factsBlocks.join("\n\n")] : []),
  ].join("\n");
  const baseSlug = slugify(product.title);
  const { data: existingKb } = await admin
    .from("knowledge_base")
    .select("id")
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id)
    .maybeSingle();
  if (existingKb) {
    await admin
      .from("knowledge_base")
      .update({ title: product.title, content: articleBody, content_html: null, category: "product", published: true, updated_at: new Date().toISOString() })
      .eq("id", existingKb.id);
  } else {
    await admin.from("knowledge_base").insert({ workspace_id, product_id, title: product.title, content: articleBody, category: "product", slug: baseSlug || null, published: true });
  }

  await admin
    .from("product_page_content")
    .update({ status: "published", published_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", contentId)
    .eq("workspace_id", workspace_id)
    .eq("product_id", product_id);

  await admin.from("products").update({ intelligence_status: "published" }).eq("id", product_id).eq("workspace_id", workspace_id);

  return { ok: true };
}
