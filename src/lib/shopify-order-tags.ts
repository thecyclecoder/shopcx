// Shopify GraphQL mutations for adding/removing order tags
// Used by fraud detection to tag orders as "suspicious" and release on dismiss

import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

async function shopifyGraphQLMutation(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<{ data?: Record<string, unknown>; errors?: { message: string }[] }> {
  const res = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
  }

  return res.json();
}

/**
 * Add tags to a Shopify order.
 * @param orderId - Shopify order ID (numeric, not GID)
 */
export async function addOrderTags(
  workspaceId: string,
  orderId: string,
  tags: string[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const mutation = `
      mutation tagsAdd($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }
    `;

    const result = await shopifyGraphQLMutation(shop, accessToken, mutation, {
      id: `gid://shopify/Order/${orderId}`,
      tags,
    });

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const userErrors = (result.data?.tagsAdd as { userErrors?: { message: string }[] })?.userErrors;
    if (userErrors?.length) {
      return { success: false, error: userErrors[0].message };
    }

    return { success: true };
  } catch (err) {
    console.error(`Failed to add tags to order ${orderId}:`, err);
    return { success: false, error: String(err) };
  }
}

/**
 * Remove tags from a Shopify order.
 * @param orderId - Shopify order ID (numeric, not GID)
 */
export async function removeOrderTags(
  workspaceId: string,
  orderId: string,
  tags: string[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);

    const mutation = `
      mutation tagsRemove($id: ID!, $tags: [String!]!) {
        tagsRemove(id: $id, tags: $tags) {
          node { id }
          userErrors { field message }
        }
      }
    `;

    const result = await shopifyGraphQLMutation(shop, accessToken, mutation, {
      id: `gid://shopify/Order/${orderId}`,
      tags,
    });

    if (result.errors?.length) {
      return { success: false, error: result.errors[0].message };
    }

    const userErrors = (result.data?.tagsRemove as { userErrors?: { message: string }[] })?.userErrors;
    if (userErrors?.length) {
      return { success: false, error: userErrors[0].message };
    }

    return { success: true };
  } catch (err) {
    console.error(`Failed to remove tags from order ${orderId}:`, err);
    return { success: false, error: String(err) };
  }
}
