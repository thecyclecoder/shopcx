import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspaceId } from "@/lib/workspace";

// Extract the local part of an email (before @), stripping +aliases
function getEmailBase(email: string): string {
  const local = email.split("@")[0]?.toLowerCase() || "";
  // Strip +alias (e.g., dylan+testing@ → dylan@)
  return local.split("+")[0];
}

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
    .select("id, email, first_name, last_name, phone, default_address")
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

  function addSuggestion(m: { id: string; email: string; first_name: string | null; last_name: string | null; phone: string | null }, reason: string) {
    if (!seenIds.has(m.id)) {
      suggestions.push({ ...m, match_reason: reason });
      seenIds.add(m.id);
    }
  }

  // 1. Match by same email local part across different domains
  // e.g., dylanralston@superfoodscompany.com ↔ dylanralston@gmail.com
  const emailBase = getEmailBase(customer.email);
  if (emailBase && emailBase.length > 3) { // Avoid matching very short bases like "hi" or "info"
    const { data: baseMatches } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("workspace_id", workspaceId)
      .ilike("email", `${emailBase}%@%`)
      .limit(10);

    for (const m of baseMatches || []) {
      const mBase = getEmailBase(m.email);
      if (mBase === emailBase) {
        addSuggestion(m, "Same email username");
      }
    }
  }

  // 2. Match by +alias variants of the same email
  // e.g., dylan@superfoodscompany.com ↔ dylan+testing@superfoodscompany.com
  const emailDomain = customer.email.split("@")[1]?.toLowerCase();
  if (emailBase && emailDomain) {
    const { data: aliasMatches } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("workspace_id", workspaceId)
      .ilike("email", `${emailBase}+%@${emailDomain}`)
      .limit(5);

    for (const m of aliasMatches || []) {
      addSuggestion(m, "Email alias (+)");
    }

    // Also check if THIS customer is a +alias and match to the base
    if (customer.email.includes("+")) {
      const { data: baseMatch } = await admin
        .from("customers")
        .select("id, email, first_name, last_name, phone")
        .eq("workspace_id", workspaceId)
        .eq("email", `${emailBase}@${emailDomain}`)
        .limit(1);

      for (const m of baseMatch || []) {
        addSuggestion(m, "Base email (without +alias)");
      }
    }
  }

  // 3. Match by phone number
  if (customer.phone) {
    const { data: phoneMatches } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("workspace_id", workspaceId)
      .eq("phone", customer.phone)
      .limit(5);

    for (const m of phoneMatches || []) {
      addSuggestion(m, "Same phone number");
    }
  }

  // 4. Match by first name + last name (exact, case-insensitive)
  if (customer.first_name && customer.last_name && customer.first_name.length > 1 && customer.last_name.length > 1) {
    const { data: nameMatches } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("workspace_id", workspaceId)
      .ilike("first_name", customer.first_name)
      .ilike("last_name", customer.last_name)
      .limit(5);

    for (const m of nameMatches || []) {
      addSuggestion(m, "Same name");
    }
  }

  // 5. Match by default address (same street + zip)
  const addr = customer.default_address as { address1?: string; zip?: string } | null;
  if (addr?.address1 && addr?.zip) {
    const { data: addrMatches } = await admin
      .from("customers")
      .select("id, email, first_name, last_name, phone")
      .eq("workspace_id", workspaceId)
      .contains("default_address", { address1: addr.address1, zip: addr.zip })
      .limit(5);

    for (const m of addrMatches || []) {
      addSuggestion(m, "Same address");
    }
  }

  return NextResponse.json({ suggestions: suggestions.slice(0, 10) });
}
