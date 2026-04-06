import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET: Single product intelligence entry
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; piId: string }> }
) {
  const { id: workspaceId, piId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data, error } = await admin.from("product_intelligence")
    .select(`
      id, workspace_id, product_id, title, content, source, source_urls, created_at, updated_at,
      products(id, title, image_url, shopify_product_id)
    `)
    .eq("id", piId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(data);
}

// PATCH: Update product intelligence (enrich with more content, edit, add URL)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; piId: string }> }
) {
  const { id: workspaceId, piId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const body = await request.json();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.content !== undefined) updates.content = body.content;
  if (body.source !== undefined) updates.source = body.source;
  if (body.source_urls !== undefined) updates.source_urls = body.source_urls;
  if (body.labeled_urls !== undefined) updates.labeled_urls = body.labeled_urls;

  // Append mode: add content to existing instead of replacing
  if (body.append_content) {
    const { data: existing } = await admin.from("product_intelligence")
      .select("content").eq("id", piId).single();
    if (existing) {
      updates.content = existing.content + "\n\n---\n\n" + body.append_content;
    }
  }

  // Append URL to source_urls
  if (body.add_url) {
    const { data: existing } = await admin.from("product_intelligence")
      .select("source_urls").eq("id", piId).single();
    const urls = (existing?.source_urls as string[]) || [];
    if (!urls.includes(body.add_url)) {
      updates.source_urls = [...urls, body.add_url];
    }
  }

  const { error } = await admin.from("product_intelligence")
    .update(updates).eq("id", piId).eq("workspace_id", workspaceId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

// DELETE: Remove product intelligence
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; piId: string }> }
) {
  const { id: workspaceId, piId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  await admin.from("product_intelligence").delete().eq("id", piId).eq("workspace_id", workspaceId);
  return NextResponse.json({ ok: true });
}
