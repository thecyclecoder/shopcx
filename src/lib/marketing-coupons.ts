/**
 * Marketing campaign coupons. One shared discount code per campaign
 * (e.g. MAYBLAST20) issued in Shopify via discountCodeBasicCreate at
 * schedule time, then disabled in Shopify by a daily cron once the
 * campaign's coupon_expires_days_after_send window closes.
 *
 * Code format: campaign-name-stem (uppercased, 3-8 chars) + 2 digit
 * random suffix. Falls back to a 6-char random Crockford-base32 if
 * the name yields a poor stem (e.g. all symbols).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

const DISCOUNT_CREATE_MUTATION = `
  mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { codes(first: 1) { nodes { code } } } } }
      userErrors { field message }
    }
  }
`;

// Sets endsAt = now to immediately disable a previously-created
// discount. Used by the daily auto-disable cron. We use the basic
// variant since that's what we created with.
const DISCOUNT_UPDATE_MUTATION = `
  mutation discountCodeBasicUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`;

interface CampaignCouponInput {
  workspaceId: string;
  campaignName: string;
  discountPct: number;            // 5–80 typical
  expiresAt: Date;
}

interface CampaignCouponResult {
  code: string;
  shopifyNodeId: string | null;
  error?: string;
}

export async function createCampaignCoupon(
  input: CampaignCouponInput,
): Promise<CampaignCouponResult> {
  const code = generateCampaignCode(input.campaignName);
  const title = `Campaign: ${input.campaignName} (${input.discountPct}% off)`;

  try {
    const { shop, accessToken } = await getShopifyCredentials(input.workspaceId);
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: DISCOUNT_CREATE_MUTATION,
          variables: {
            basicCodeDiscount: {
              title, code,
              startsAt: new Date().toISOString(),
              endsAt: input.expiresAt.toISOString(),
              // Marketing codes — unlimited uses across the audience.
              // No per-customer cap; the same person could use it on
              // multiple orders within the window. Adjust later per
              // policy if abuse becomes a thing.
              usageLimit: null,
              appliesOncePerCustomer: false,
              combinesWith: {
                productDiscounts: false,
                shippingDiscounts: true,
                orderDiscounts: false,
              },
              customerSelection: { all: true },
              customerGets: {
                appliesOnOneTimePurchase: true,
                appliesOnSubscription: true,
                items: { all: true },
                value: {
                  percentage: input.discountPct / 100,
                },
              },
            },
          },
        }),
      },
    );

    if (!res.ok) {
      return { code, shopifyNodeId: null, error: `Shopify API ${res.status}` };
    }
    const gql = await res.json();
    const userErrors = gql?.data?.discountCodeBasicCreate?.userErrors as Array<{ message: string }> | undefined;
    if (userErrors?.length) {
      return { code, shopifyNodeId: null, error: userErrors.map(e => e.message).join("; ") };
    }
    const nodeId = gql?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;
    return { code, shopifyNodeId: nodeId };
  } catch (err) {
    return { code, shopifyNodeId: null, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Disable a previously-created campaign coupon by setting its endsAt
 * to now. Idempotent — calling on an already-disabled code is fine.
 */
export async function disableCampaignCoupon(
  workspaceId: string,
  shopifyNodeId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: DISCOUNT_UPDATE_MUTATION,
          variables: {
            id: shopifyNodeId,
            basicCodeDiscount: {
              endsAt: new Date().toISOString(),
            },
          },
        }),
      },
    );

    if (!res.ok) return { success: false, error: `Shopify API ${res.status}` };
    const gql = await res.json();
    const userErrors = gql?.data?.discountCodeBasicUpdate?.userErrors as Array<{ message: string }> | undefined;
    if (userErrors?.length) return { success: false, error: userErrors.map(e => e.message).join("; ") };
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Build a campaign code from the campaign name. Aim for human-typeable
 * + memorable; fall back to random if the name yields a bad stem.
 *
 *   "May coffee restock blast"   → "MAYBL47"
 *   "Black Friday 2026"          → "BLACKF92"
 *   "🎉 hello 🎉"                → "B3K7N2" (random Crockford)
 */
export function generateCampaignCode(campaignName: string): string {
  // Take letters from the name, prefer the first few words, cap at 6.
  const stem = (campaignName || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.slice(0, 5))
    .join("")
    .slice(0, 6);

  if (stem.length >= 3) {
    // Append a 2-digit suffix to make repeated campaigns with similar
    // names get unique codes. Reduces accidental cross-campaign
    // collisions while still feeling human.
    const suffix = String(Math.floor(Math.random() * 90) + 10);
    return `${stem}${suffix}`;
  }

  // Fall back to fully random 6-char Crockford-base32.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * Build the absolute campaign shortlink URL from the workspace's
 * configured shortlink_domain + slug. Returns null when the workspace
 * has no shortlink domain set yet — caller should surface that to
 * the admin before they schedule a campaign with shortlinks enabled.
 */
export async function buildShortlinkUrl(
  workspaceId: string,
  slug: string,
): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select("shortlink_domain")
    .eq("id", workspaceId)
    .single();
  if (!data?.shortlink_domain) return null;
  return `https://${data.shortlink_domain}/${slug}`;
}
