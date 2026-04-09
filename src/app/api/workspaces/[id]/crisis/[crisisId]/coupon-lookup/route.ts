import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

// POST — look up a Shopify discount code and return details
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; crisisId: string }> },
) {
  const { id: workspaceId } = await params;

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

  const body = await request.json();
  const code = (body.code || "").trim();
  if (!code) return NextResponse.json({ error: "code is required" }, { status: 400 });

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    // Look up discount code via Shopify GraphQL
    const query = `{
      codeDiscountNodeByCode(code: "${code.replace(/"/g, '\\"')}") {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            status
            startsAt
            endsAt
            usageLimit
            asyncUsageCount
            summary
            codes(first: 1) { nodes { code } }
            customerGets {
              value {
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount currencyCode } }
              }
              items {
                ... on AllDiscountItems { allItems }
              }
            }
          }
          ... on DiscountCodeFreeShipping {
            title
            status
            startsAt
            endsAt
            summary
          }
          ... on DiscountCodeBxgy {
            title
            status
            startsAt
            endsAt
            summary
            usageLimit
            asyncUsageCount
          }
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
      },
    );

    if (!res.ok) {
      return NextResponse.json({ error: `Shopify API error: ${res.status}` }, { status: 502 });
    }

    const json = await res.json();
    const node = json.data?.codeDiscountNodeByCode;

    if (!node) {
      return NextResponse.json({ error: "Discount code not found", found: false }, { status: 404 });
    }

    const discount = node.codeDiscount;
    const customerGets = discount.customerGets;
    const value = customerGets?.value;

    let type = "unknown";
    let percentage: number | null = null;
    let fixedAmount: string | null = null;
    let currencyCode: string | null = null;

    if (value?.percentage !== undefined) {
      type = "percentage";
      percentage = Math.round(value.percentage * 100);
    } else if (value?.amount) {
      type = "fixed_amount";
      fixedAmount = value.amount.amount;
      currencyCode = value.amount.currencyCode;
    } else if (discount.summary?.toLowerCase().includes("free shipping")) {
      type = "free_shipping";
    }

    return NextResponse.json({
      found: true,
      code: discount.codes?.nodes?.[0]?.code || code,
      title: discount.title,
      status: discount.status,
      type,
      percentage,
      fixed_amount: fixedAmount,
      currency_code: currencyCode,
      summary: discount.summary,
      starts_at: discount.startsAt,
      ends_at: discount.endsAt,
      usage_limit: discount.usageLimit ?? null,
      usage_count: discount.asyncUsageCount ?? null,
    });
  } catch (err) {
    console.error("Coupon lookup error:", err);
    return NextResponse.json({ error: "Failed to look up discount code" }, { status: 500 });
  }
}
