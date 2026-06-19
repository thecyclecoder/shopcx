/**
 * Publish a product's generated page content (shared by the Engine UI route and
 * the box seed pipeline). Creates support macros (inactive), upserts the KB
 * article, flips `product_page_content.status='published'` and
 * `products.intelligence_status='published'`. Reuse, never fork.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

type SupportMacro = { title: string; body_text: string; body_html?: string; question_type: string };

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

  // KB article.
  const articleBody = [content.knowledge_base_article || "", "", "## What this product does not do", "", content.kb_what_it_doesnt_do || ""].join("\n");
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
