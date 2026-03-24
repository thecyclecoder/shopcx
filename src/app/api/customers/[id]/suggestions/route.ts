import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspaceId } from "@/lib/workspace";

// GET: find potential duplicate customers to link
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: customerId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Get the current customer
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, first_name, last_name, phone")
    .eq("id", customerId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!customer) return NextResponse.json({ suggestions: [] });

  // Get already linked IDs to exclude
  const { data: existingLinks } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .single();

  const excludeIds = [customerId];
  if (existingLinks) {
    const { data: groupMembers } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", existingLinks.group_id);
    for (const m of groupMembers || []) {
      excludeIds.push(m.customer_id);
    }
  }

  const suggestions: { id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null; match_reason: string }[] = [];
  const seenIds = new Set(excludeIds);

  // Match by name (first + last)
  if (customer.first_name && customer.last_name) {
    const { data: nameMatches } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("workspace_id", workspaceId)
      .ilike("first_name", customer.first_name)
      .ilike("last_name", customer.last_name)
      .limit(5);

    for (const m of nameMatches || []) {
      if (!seenIds.has(m.id)) {
        suggestions.push({ ...m, match_reason: "Same name" });
        seenIds.add(m.id);
      }
    }
  }

  // Match by phone
  if (customer.phone) {
    const { data: phoneMatches } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("workspace_id", workspaceId)
      .eq("phone", customer.phone)
      .limit(5);

    for (const m of phoneMatches || []) {
      if (!seenIds.has(m.id)) {
        suggestions.push({ ...m, match_reason: "Same phone" });
        seenIds.add(m.id);
      }
    }
  }

  // Match by email domain (same person, different email at same company)
  const emailDomain = customer.email.split("@")[1];
  if (emailDomain && !emailDomain.includes("phone.local") && !["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com"].includes(emailDomain)) {
    const { data: domainMatches } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("workspace_id", workspaceId)
      .ilike("email", `%@${emailDomain}`)
      .limit(5);

    for (const m of domainMatches || []) {
      if (!seenIds.has(m.id)) {
        suggestions.push({ ...m, match_reason: "Same email domain" });
        seenIds.add(m.id);
      }
    }
  }

  return NextResponse.json({ suggestions: suggestions.slice(0, 10) });
}
