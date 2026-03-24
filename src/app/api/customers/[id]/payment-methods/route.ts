import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { decrypt } from "@/lib/crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

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

  // Get customer's Shopify ID
  const { data: customer } = await admin
    .from("customers")
    .select("shopify_customer_id")
    .eq("id", customerId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!customer?.shopify_customer_id) {
    return NextResponse.json({ payment_methods: [] });
  }

  // Get Shopify credentials
  const { data: workspace } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", workspaceId)
    .single();

  if (!workspace?.shopify_access_token_encrypted || !workspace?.shopify_myshopify_domain) {
    return NextResponse.json({ payment_methods: [] });
  }

  const shop = workspace.shopify_myshopify_domain;
  const token = decrypt(workspace.shopify_access_token_encrypted);
  const gid = `gid://shopify/Customer/${customer.shopify_customer_id}`;

  const query = `{
    customer(id: "${gid}") {
      paymentMethods(first: 10) {
        edges {
          node {
            id
            instrument {
              __typename
              ... on CustomerCreditCard {
                brand lastDigits expiryMonth expiryYear
              }
              ... on CustomerShopPayAgreement {
                lastDigits expiryMonth expiryYear
              }
              ... on CustomerPaypalBillingAgreement {
                paypalAccountEmail
              }
            }
          }
        }
      }
    }
  }`;

  try {
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query }),
      }
    );

    if (!res.ok) return NextResponse.json({ payment_methods: [] });
    const json = await res.json();
    const edges = json.data?.customer?.paymentMethods?.edges || [];

    // Deduplicate by type + lastDigits
    const seen = new Set<string>();
    const methods = [];
    for (const edge of edges) {
      const inst = edge.node.instrument;
      const key = `${inst.__typename}-${inst.lastDigits || inst.paypalAccountEmail || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      if (inst.__typename === "CustomerCreditCard") {
        methods.push({
          type: "credit_card",
          brand: inst.brand,
          last_digits: inst.lastDigits,
          expiry: `${inst.expiryMonth}/${inst.expiryYear}`,
        });
      } else if (inst.__typename === "CustomerShopPayAgreement") {
        methods.push({
          type: "shop_pay",
          last_digits: inst.lastDigits,
          expiry: `${inst.expiryMonth}/${inst.expiryYear}`,
        });
      } else if (inst.__typename === "CustomerPaypalBillingAgreement") {
        methods.push({
          type: "paypal",
          email: inst.paypalAccountEmail || null,
        });
      }
    }

    return NextResponse.json({ payment_methods: methods });
  } catch {
    return NextResponse.json({ payment_methods: [] });
  }
}
