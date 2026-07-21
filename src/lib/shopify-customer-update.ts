/**
 * Update a Shopify customer's contact fields (phone / email /
 * first_name / last_name) via the GraphQL `customerUpdate` mutation.
 *
 * Phone must be E.164. Email is validated by Shopify (returns
 * userErrors on bad format). We pass-through any provided field;
 * fields omitted from the input are left unchanged.
 *
 * Returns { success, error?, shopifyErrors? }.
 */
import { decrypt } from "@/lib/crypto";
import { errText } from "@/lib/error-text";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { createAdminClient } from "@/lib/supabase/admin";

export interface ShopifyCustomerUpdateInput {
  workspaceId: string;
  shopifyCustomerId: string;     // numeric id, no "gid://" prefix needed
  phone?: string | null;         // E.164, e.g. "+17208087208"
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface ShopifyCustomerUpdateResult {
  success: boolean;
  error?: string;
  shopifyErrors?: Array<{ field?: string[] | null; message: string }>;
}

export async function updateShopifyCustomer(input: ShopifyCustomerUpdateInput): Promise<ShopifyCustomerUpdateResult> {
  if (!input.phone && !input.email && input.firstName == null && input.lastName == null) {
    return { success: false, error: "nothing to update" };
  }

  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_domain, shopify_access_token_encrypted")
    .eq("id", input.workspaceId)
    .single();
  const shop = (ws?.shopify_myshopify_domain as string) || (ws?.shopify_domain as string);
  if (!shop || !ws?.shopify_access_token_encrypted) {
    return { success: false, error: "shopify_not_configured" };
  }
  const accessToken = decrypt(ws.shopify_access_token_encrypted as string);

  const gid = input.shopifyCustomerId.startsWith("gid://")
    ? input.shopifyCustomerId
    : `gid://shopify/Customer/${input.shopifyCustomerId}`;

  // Build the mutation input — only fields the caller provided.
  type CustomerInput = { id: string; phone?: string; email?: string; firstName?: string; lastName?: string };
  const variables: { input: CustomerInput } = { input: { id: gid } };
  if (input.phone) variables.input.phone = input.phone;
  if (input.email) variables.input.email = input.email;
  if (input.firstName != null) variables.input.firstName = input.firstName;
  if (input.lastName != null) variables.input.lastName = input.lastName;

  const query = `
    mutation customerUpdate($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id phone email firstName lastName }
        userErrors { field message }
      }
    }
  `;

  try {
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { success: false, error: `shopify_${res.status}: ${txt.slice(0, 300)}` };
    }
    const data = await res.json();
    const userErrors = data?.data?.customerUpdate?.userErrors as Array<{ field?: string[] | null; message: string }> | undefined;
    if (userErrors && userErrors.length > 0) {
      return {
        success: false,
        error: userErrors.map((e) => `${(e.field || []).join(".")}: ${e.message}`).join("; "),
        shopifyErrors: userErrors,
      };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: errText(err) };
  }
}

// Canonical phone normalization now lives in @/lib/phone. Re-exported here for
// the existing callers (action-executor, checkout OTP routes) that import it
// from this module.
export { toE164US } from "@/lib/phone";
