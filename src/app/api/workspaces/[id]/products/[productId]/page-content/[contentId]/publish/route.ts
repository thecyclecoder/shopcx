import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

type SupportMacro = {
  title: string;
  body_text: string;
  body_html?: string;
  question_type: string;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; contentId: string }> },
) {
  const { id: workspaceId, productId, contentId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: content } = await admin
    .from("product_page_content")
    .select("*")
    .eq("id", contentId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .single();

  if (!content) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Block publishing if "what it doesn't do" is empty
  if (!content.kb_what_it_doesnt_do || !content.kb_what_it_doesnt_do.trim()) {
    return NextResponse.json(
      { error: "Cannot publish: 'What it doesn\\'t do' section is required." },
      { status: 400 },
    );
  }

  const { data: product } = await admin
    .from("products")
    .select("id, title")
    .eq("id", productId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });

  // Create macros (inactive by default — editorial review in macros settings)
  const macros = (content.support_macros as SupportMacro[]) || [];
  for (const m of macros) {
    if (!m?.title || !m?.body_text) continue;
    await admin.from("macros").insert({
      workspace_id: workspaceId,
      name: m.title,
      body_text: m.body_text,
      body_html: m.body_html || null,
      category: "product",
      tags: ["product-intelligence", `qtype:${m.question_type || "general"}`],
      active: false,
    });
  }

  // Create / update KB article
  const articleBody = [
    content.knowledge_base_article || "",
    "",
    "## What this product does not do",
    "",
    content.kb_what_it_doesnt_do || "",
  ].join("\n");

  const baseSlug = slugify(product.title);
  const { data: existingKb } = await admin
    .from("knowledge_base")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .maybeSingle();

  if (existingKb) {
    await admin
      .from("knowledge_base")
      .update({
        title: product.title,
        content: articleBody,
        content_html: null,
        category: "product",
        published: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existingKb.id);
  } else {
    await admin.from("knowledge_base").insert({
      workspace_id: workspaceId,
      product_id: productId,
      title: product.title,
      content: articleBody,
      category: "product",
      slug: baseSlug || null,
      published: true,
    });
  }

  await admin
    .from("product_page_content")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", contentId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);

  await admin
    .from("products")
    .update({ intelligence_status: "published" })
    .eq("id", productId)
    .eq("workspace_id", workspaceId);

  return NextResponse.json({ success: true });
}
