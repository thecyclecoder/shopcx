import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

// POST: Lazy-enrich a customer from Shopify if missing personalization
export async function POST(
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

  // Fetch the customer
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, first_name, last_name, shopify_customer_id, phone")
    .eq("id", customerId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Already has personalization — nothing to do
  if (customer.first_name && customer.last_name) {
    return NextResponse.json({ enriched: false, customer });
  }

  let shopifyCustomerId = customer.shopify_customer_id;

  // If no shopify_customer_id, check linked profiles
  if (!shopifyCustomerId) {
    const { data: link } = await admin
      .from("customer_links")
      .select("group_id")
      .eq("customer_id", customerId)
      .single();

    if (link) {
      const { data: groupLinks } = await admin
        .from("customer_links")
        .select("customer_id")
        .eq("group_id", link.group_id);

      for (const gl of groupLinks || []) {
        if (gl.customer_id === customerId) continue;
        const { data: linked } = await admin
          .from("customers")
          .select("shopify_customer_id, first_name, last_name, phone")
          .eq("id", gl.customer_id)
          .single();

        if (linked?.shopify_customer_id) {
          shopifyCustomerId = linked.shopify_customer_id;
          // If the linked profile already has the name, just copy it
          if (linked.first_name) {
            const updates: Record<string, unknown> = {
              first_name: linked.first_name,
              last_name: linked.last_name,
              updated_at: new Date().toISOString(),
            };
            if (!customer.phone && linked.phone) updates.phone = linked.phone;
            await admin.from("customers").update(updates).eq("id", customerId);
            const { data: updated } = await admin.from("customers").select("*").eq("id", customerId).single();
            return NextResponse.json({ enriched: true, source: "linked_profile", customer: updated });
          }
          break;
        }
      }
    }
  }

  // If still no shopify_customer_id, search Shopify by email
  if (!shopifyCustomerId && customer.email) {
    try {
      const { shop, accessToken } = await getShopifyCredentials(workspaceId);
      const searchQuery = `{
        customers(first: 1, query: "email:${customer.email}") {
          edges { node { id firstName lastName phone } }
        }
      }`;

      const res = await fetch(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: searchQuery }),
        }
      );

      if (res.ok) {
        const json = await res.json();
        const node = json.data?.customers?.edges?.[0]?.node;
        if (node) {
          const gid = node.id as string;
          shopifyCustomerId = gid.split("/").pop() || null;

          const updates: Record<string, unknown> = {
            shopify_customer_id: shopifyCustomerId,
            updated_at: new Date().toISOString(),
          };
          if (node.firstName) updates.first_name = node.firstName;
          if (node.lastName) updates.last_name = node.lastName;
          if (node.phone && !customer.phone) updates.phone = node.phone;

          await admin.from("customers").update(updates).eq("id", customerId);
          const { data: updated } = await admin.from("customers").select("*").eq("id", customerId).single();
          return NextResponse.json({ enriched: true, source: "shopify_search", customer: updated });
        }
      }
    } catch {
      // Shopify not connected or query failed — skip
    }
  }

  // Have shopify_customer_id but no name — fetch from Shopify
  if (shopifyCustomerId && !customer.first_name) {
    try {
      const { shop, accessToken } = await getShopifyCredentials(workspaceId);
      const gid = `gid://shopify/Customer/${shopifyCustomerId}`;
      const query = `{
        customer(id: "${gid}") {
          firstName lastName phone
          defaultAddress {
            address1 address2 city province provinceCode country countryCodeV2 zip
          }
        }
      }`;

      const res = await fetch(
        `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query }),
        }
      );

      if (res.ok) {
        const json = await res.json();
        const c = json.data?.customer;
        if (c) {
          const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
          if (c.firstName) updates.first_name = c.firstName;
          if (c.lastName) updates.last_name = c.lastName;
          if (c.phone && !customer.phone) updates.phone = c.phone;
          if (c.defaultAddress) updates.default_address = c.defaultAddress;
          if (!customer.shopify_customer_id) updates.shopify_customer_id = shopifyCustomerId;

          await admin.from("customers").update(updates).eq("id", customerId);
          const { data: updated } = await admin.from("customers").select("*").eq("id", customerId).single();
          return NextResponse.json({ enriched: true, source: "shopify_direct", customer: updated });
        }
      }
    } catch {
      // Skip
    }
  }

  return NextResponse.json({ enriched: false, customer });
}
