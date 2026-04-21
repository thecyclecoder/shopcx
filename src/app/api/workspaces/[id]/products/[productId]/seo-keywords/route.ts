import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// GET: list keyword research results
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: keywords } = await admin.from("product_seo_keywords")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("monthly_searches", { ascending: false });

  // Get SEO metadata from page content
  const { data: content } = await admin.from("product_page_content")
    .select("seo_title, seo_description, seo_keywords")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({
    keywords: keywords || [],
    seo_meta: content ? {
      title: content.seo_title,
      description: content.seo_description,
      keywords: content.seo_keywords,
    } : null,
  });
}

// POST: trigger keyword research
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await inngest.send({
    name: "seo/research-keywords",
    data: { workspace_id: workspaceId, product_id: productId },
  });

  return NextResponse.json({ success: true });
}

// PUT: save selected keywords + generate SEO metadata
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json().catch(() => ({}));

  // Update selected state
  if (Array.isArray(body.selected_keywords)) {
    // Deselect all first
    await admin.from("product_seo_keywords")
      .update({ is_selected: false })
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId);

    // Select the chosen ones
    if (body.selected_keywords.length > 0) {
      for (let i = 0; i < body.selected_keywords.length; i += 100) {
        await admin.from("product_seo_keywords")
          .update({ is_selected: true })
          .eq("workspace_id", workspaceId)
          .eq("product_id", productId)
          .in("keyword", body.selected_keywords.slice(i, i + 100));
      }
    }
  }

  // Save SEO metadata
  if (body.seo_title || body.seo_description || body.seo_keywords) {
    const update: Record<string, unknown> = {};
    if (typeof body.seo_title === "string") update.seo_title = body.seo_title;
    if (typeof body.seo_description === "string") update.seo_description = body.seo_description;
    if (Array.isArray(body.seo_keywords)) update.seo_keywords = body.seo_keywords;

    // Update the latest version of page content
    const { data: latest } = await admin.from("product_page_content")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latest) {
      await admin.from("product_page_content").update(update).eq("id", latest.id);
    }
  }

  return NextResponse.json({ success: true });
}
