// Shopify marketing consent management
// Subscribe/unsubscribe customers to email and SMS marketing

import { getShopifyCredentials } from "@/lib/shopify-sync";
import { errText } from "@/lib/error-text";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { createAdminClient } from "@/lib/supabase/admin";

interface MarketingResult {
  success: boolean;
  email_subscribed?: boolean;
  sms_subscribed?: boolean;
  error?: string;
}

export async function subscribeToEmailMarketing(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<MarketingResult> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const mutation = `
      mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
        customerEmailMarketingConsentUpdate(input: $input) {
          customer { id emailMarketingConsent { marketingState } }
          userErrors { field message }
        }
      }
    `;

    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            customerId: `gid://shopify/Customer/${shopifyCustomerId}`,
            emailMarketingConsent: {
              marketingState: "SUBSCRIBED",
              consentUpdatedAt: new Date().toISOString(),
              marketingOptInLevel: "SINGLE_OPT_IN",
            },
          },
        },
      }),
    });

    const data = await res.json();
    const errors = data?.data?.customerEmailMarketingConsentUpdate?.userErrors;
    if (errors?.length) {
      return { success: false, error: errors[0].message };
    }

    return { success: true, email_subscribed: true };
  } catch (err) {
    return { success: false, error: errText(err) };
  }
}

export async function subscribeToSmsMarketing(
  workspaceId: string,
  shopifyCustomerId: string,
  phone?: string,
): Promise<MarketingResult> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const mutation = `
      mutation customerSmsMarketingConsentUpdate($input: CustomerSmsMarketingConsentUpdateInput!) {
        customerSmsMarketingConsentUpdate(input: $input) {
          customer { id smsMarketingConsent { marketingState } }
          userErrors { field message }
        }
      }
    `;

    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            customerId: `gid://shopify/Customer/${shopifyCustomerId}`,
            smsMarketingConsent: {
              marketingState: "SUBSCRIBED",
              consentUpdatedAt: new Date().toISOString(),
              marketingOptInLevel: "SINGLE_OPT_IN",
            },
          },
        },
      }),
    });

    const data = await res.json();
    const errors = data?.data?.customerSmsMarketingConsentUpdate?.userErrors;
    if (errors?.length) {
      return { success: false, error: errors[0].message };
    }

    return { success: true, sms_subscribed: true };
  } catch (err) {
    return { success: false, error: errText(err) };
  }
}

export async function unsubscribeFromEmailMarketing(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<MarketingResult> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
          customerEmailMarketingConsentUpdate(input: $input) {
            customer { id emailMarketingConsent { marketingState } }
            userErrors { field message }
          }
        }`,
        variables: {
          input: {
            customerId: `gid://shopify/Customer/${shopifyCustomerId}`,
            emailMarketingConsent: { marketingState: "UNSUBSCRIBED", consentUpdatedAt: new Date().toISOString() },
          },
        },
      }),
    });

    const data = await res.json();
    const errors = data?.data?.customerEmailMarketingConsentUpdate?.userErrors;
    if (errors?.length) return { success: false, error: errors[0].message };
    return { success: true, email_subscribed: false };
  } catch (err) {
    return { success: false, error: errText(err) };
  }
}

export async function unsubscribeFromSmsMarketing(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<MarketingResult> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation customerSmsMarketingConsentUpdate($input: CustomerSmsMarketingConsentUpdateInput!) {
          customerSmsMarketingConsentUpdate(input: $input) {
            customer { id smsMarketingConsent { marketingState } }
            userErrors { field message }
          }
        }`,
        variables: {
          input: {
            customerId: `gid://shopify/Customer/${shopifyCustomerId}`,
            smsMarketingConsent: { marketingState: "UNSUBSCRIBED", consentUpdatedAt: new Date().toISOString() },
          },
        },
      }),
    });

    const data = await res.json();
    const errors = data?.data?.customerSmsMarketingConsentUpdate?.userErrors;
    if (errors?.length) return { success: false, error: errors[0].message };
    return { success: true, sms_subscribed: false };
  } catch (err) {
    return { success: false, error: errText(err) };
  }
}

// Unsubscribe a customer from all marketing (email + SMS) and update local DB
/**
 * Unsubscribe from both email AND SMS marketing on the Shopify side.
 * Signature mirrors unsubscribeFromEmailMarketing / unsubscribeFromSmsMarketing
 * (workspaceId + shopifyCustomerId) — the previous signature took OUR
 * customer UUID and re-queried, which broke when callers passed the
 * Shopify ID directly (every existing caller does). Beverly's ticket
 * 8ad98c3e was the canary — handler passed shopify_customer_id and got
 * "No Shopify ID" back because the helper queried `customers WHERE
 * id = $shopifyId`, which never matched.
 *
 * Local-DB update is the caller's responsibility (the action handler
 * already does it; doing it twice would race against the caller's
 * intent if they wanted to override status names like
 * "not_subscribed" vs "unsubscribed").
 */
export async function unsubscribeFromAllMarketing(
  workspaceId: string,
  shopifyCustomerId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!shopifyCustomerId) return { success: false, error: "No Shopify ID" };

  const [emailRes, smsRes] = await Promise.all([
    unsubscribeFromEmailMarketing(workspaceId, shopifyCustomerId),
    unsubscribeFromSmsMarketing(workspaceId, shopifyCustomerId),
  ]);

  if (!emailRes.success && !smsRes.success) {
    return { success: false, error: `email: ${emailRes.error}, sms: ${smsRes.error}` };
  }
  return { success: emailRes.success || smsRes.success };
}

// Combined: subscribe to both email and SMS
export async function subscribeToMarketing(
  workspaceId: string,
  customerId: string,
  channels: ("email" | "sms")[],
): Promise<MarketingResult> {
  const admin = createAdminClient();

  // Get Shopify customer ID
  const { data: customer } = await admin
    .from("customers")
    .select("shopify_customer_id, phone")
    .eq("id", customerId)
    .single();

  if (!customer?.shopify_customer_id) {
    return { success: false, error: "Customer not linked to Shopify" };
  }

  let emailResult: MarketingResult = { success: true };
  let smsResult: MarketingResult = { success: true };

  if (channels.includes("email")) {
    emailResult = await subscribeToEmailMarketing(workspaceId, customer.shopify_customer_id);
  }

  if (channels.includes("sms")) {
    if (!customer.phone) {
      smsResult = { success: false, error: "No phone number on file" };
    } else {
      smsResult = await subscribeToSmsMarketing(workspaceId, customer.shopify_customer_id, customer.phone);
    }
  }

  return {
    success: emailResult.success || smsResult.success,
    email_subscribed: emailResult.email_subscribed,
    sms_subscribed: smsResult.sms_subscribed,
    error: [emailResult.error, smsResult.error].filter(Boolean).join("; ") || undefined,
  };
}
