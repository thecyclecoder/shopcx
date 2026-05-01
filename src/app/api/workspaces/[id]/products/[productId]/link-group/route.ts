import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Revalidate the storefront PDP for every product in `productIds`.
 * Both URL shapes (admin preview and public custom domain) are
 * revalidated so the toggle appears immediately on either side.
 */
async function revalidateMembers(
  admin: SupabaseClient,
  workspaceId: string,
  productIds: string[],
) {
  if (!productIds.length) return;
  const [{ data: products }, { data: ws }] = await Promise.all([
    admin.from("products").select("handle").in("id", productIds).eq("workspace_id", workspaceId),
    admin.from("workspaces").select("storefront_slug").eq("id", workspaceId).single(),
  ]);
  for (const p of products || []) {
    if (!p.handle) continue;
    if (ws?.storefront_slug) revalidatePath(`/store/${ws.storefront_slug}/${p.handle}`);
    revalidatePath(`/${p.handle}`);
  }
}

/**
 * Linked-products worksheet API. One link group per product (a product
 * can only belong to one link group). PUT replaces the whole worksheet
 * — caller sends { link_type, name, members: [{product_id, value,
 * display_order}] } and we sync `product_link_members` to match.
 *
 * Bidirectional by design: if Amazing Coffee is grouped with Amazing
 * Coffee K-Cups, the K-Cups page sees the same group automatically.
 */

type MemberInput = {
  product_id: string;
  value: string;
  display_order?: number | null;
};

async function authorize(workspaceId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: "Unauthorized", status: 401 as const };

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return { error: "Forbidden", status: 403 as const };
  return { admin };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  const auth = await authorize(workspaceId);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { admin } = auth;

  // Find the group via this product's membership row (a product is in
  // at most one group).
  const { data: myMembership } = await admin
    .from("product_link_members")
    .select("group_id")
    .eq("product_id", productId)
    .maybeSingle();

  if (!myMembership) return NextResponse.json({ group: null });

  const { data: group } = await admin
    .from("product_link_groups")
    .select("id, link_type, name")
    .eq("id", myMembership.group_id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!group) return NextResponse.json({ group: null });

  const { data: members } = await admin
    .from("product_link_members")
    .select("id, product_id, value, display_order, products(title, handle, image_url)")
    .eq("group_id", group.id)
    .order("display_order", { ascending: true });

  type Row = {
    id: string;
    product_id: string;
    value: string;
    display_order: number;
    products: { title: string; handle: string; image_url: string | null } | null;
  };

  const shaped = (members as unknown as Row[] | null || []).map(m => ({
    id: m.id,
    product_id: m.product_id,
    value: m.value,
    display_order: m.display_order,
    product_title: m.products?.title || "",
    product_handle: m.products?.handle || "",
    image_url: m.products?.image_url || null,
  }));

  return NextResponse.json({
    group: { id: group.id, link_type: group.link_type, name: group.name, members: shaped },
  });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  const auth = await authorize(workspaceId);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { admin } = auth;

  const body = await req.json().catch(() => ({}));
  const linkType = String(body.link_type || "").trim();
  const name = String(body.name || "").trim();
  const rawMembers: MemberInput[] = Array.isArray(body.members) ? body.members : [];

  if (!linkType || !name) {
    return NextResponse.json({ error: "link_type and name are required" }, { status: 400 });
  }
  if (rawMembers.length < 2) {
    return NextResponse.json({ error: "A link group needs at least 2 members" }, { status: 400 });
  }
  if (!rawMembers.some(m => m.product_id === productId)) {
    return NextResponse.json({ error: "Current product must be one of the members" }, { status: 400 });
  }
  if (rawMembers.some(m => !m.product_id || !String(m.value || "").trim())) {
    return NextResponse.json({ error: "Every member needs a product_id and value" }, { status: 400 });
  }

  // All member products must belong to this workspace — no cross-tenant linking.
  const memberIds = rawMembers.map(m => m.product_id);
  const { data: validProducts } = await admin
    .from("products")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("id", memberIds);
  if ((validProducts?.length || 0) !== memberIds.length) {
    return NextResponse.json({ error: "One or more products not found in this workspace" }, { status: 400 });
  }

  // Find existing group for this product, if any.
  const { data: existing } = await admin
    .from("product_link_members")
    .select("group_id")
    .eq("product_id", productId)
    .maybeSingle();

  // If any of the new members are already in a DIFFERENT group, that's
  // a conflict — caller must remove them from the other group first.
  const { data: conflicts } = await admin
    .from("product_link_members")
    .select("product_id, group_id")
    .in("product_id", memberIds);
  const conflictRow = (conflicts || []).find(c =>
    c.group_id !== (existing?.group_id || null) && c.product_id !== productId,
  );
  if (conflictRow) {
    return NextResponse.json(
      { error: `Product ${conflictRow.product_id} is already in another link group. Remove it first.` },
      { status: 409 },
    );
  }

  let groupId = existing?.group_id || null;

  if (groupId) {
    await admin
      .from("product_link_groups")
      .update({ link_type: linkType, name, updated_at: new Date().toISOString() })
      .eq("id", groupId)
      .eq("workspace_id", workspaceId);
  } else {
    const { data: created, error: createErr } = await admin
      .from("product_link_groups")
      .insert({ workspace_id: workspaceId, link_type: linkType, name })
      .select("id")
      .single();
    if (createErr || !created) {
      return NextResponse.json({ error: createErr?.message || "Failed to create group" }, { status: 500 });
    }
    groupId = created.id;
  }

  // Replace member set: delete then insert (small list, transactional
  // safety not critical for a manual admin worksheet).
  await admin.from("product_link_members").delete().eq("group_id", groupId);

  const memberRows = rawMembers.map((m, i) => ({
    group_id: groupId,
    product_id: m.product_id,
    value: String(m.value).trim(),
    display_order: m.display_order ?? i,
  }));
  const { error: insertErr } = await admin.from("product_link_members").insert(memberRows);
  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Revalidate every member's storefront PDP so the toggle appears
  // (and updates) immediately rather than waiting on the 1-hour ISR.
  await revalidateMembers(admin, workspaceId, memberIds);

  return NextResponse.json({ group_id: groupId, ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;
  const auth = await authorize(workspaceId);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { admin } = auth;

  const { data: membership } = await admin
    .from("product_link_members")
    .select("group_id")
    .eq("product_id", productId)
    .maybeSingle();

  if (!membership) return NextResponse.json({ ok: true });

  // Capture every member's product_id BEFORE the cascade so we know
  // which storefront pages need their cache invalidated (the toggle
  // disappears, the rating reverts to per-product, etc.).
  const { data: priorMembers } = await admin
    .from("product_link_members")
    .select("product_id")
    .eq("group_id", membership.group_id);
  const priorProductIds = (priorMembers || []).map(m => m.product_id);

  // Cascade: members FK has ON DELETE CASCADE on groups; deleting the
  // group wipes every member row. This is the right call since a group
  // with one member has nothing to toggle.
  await admin
    .from("product_link_groups")
    .delete()
    .eq("id", membership.group_id)
    .eq("workspace_id", workspaceId);

  await revalidateMembers(admin, workspaceId, priorProductIds);

  return NextResponse.json({ ok: true });
}
