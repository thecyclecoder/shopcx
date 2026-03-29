// Shopify subscription contract draft workflow for line item + date mutations
// Flow: subscriptionContractUpdate → draft mutations → subscriptionDraftCommit

import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

async function shopifyGQL(
  shop: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${json.errors[0].message}`);
  }
  return json.data;
}

// ── Draft workflow: create draft from contract ──

async function createDraft(
  shop: string,
  accessToken: string,
  contractId: string,
): Promise<string> {
  const data = await shopifyGQL(shop, accessToken, `
    mutation subscriptionContractUpdate($contractId: ID!) {
      subscriptionContractUpdate(contractId: $contractId) {
        draft { id }
        userErrors { field message }
      }
    }
  `, { contractId: `gid://shopify/SubscriptionContract/${contractId}` });

  const result = data.subscriptionContractUpdate as {
    draft: { id: string } | null;
    userErrors: { message: string }[];
  };
  if (result.userErrors?.length) throw new Error(result.userErrors[0].message);
  if (!result.draft) throw new Error("Failed to create subscription draft");
  return result.draft.id;
}

async function commitDraft(
  shop: string,
  accessToken: string,
  draftId: string,
): Promise<string> {
  const data = await shopifyGQL(shop, accessToken, `
    mutation subscriptionDraftCommit($draftId: ID!) {
      subscriptionDraftCommit(draftId: $draftId) {
        contract { id }
        userErrors { field message }
      }
    }
  `, { draftId });

  const result = data.subscriptionDraftCommit as {
    contract: { id: string } | null;
    userErrors: { message: string }[];
  };
  if (result.userErrors?.length) throw new Error(result.userErrors[0].message);
  return result.contract?.id || "";
}

// ── Line item mutations ──

export async function addLineItem(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const draftId = await createDraft(shop, accessToken, contractId);

    await shopifyGQL(shop, accessToken, `
      mutation subscriptionDraftLineAdd($draftId: ID!, $input: SubscriptionLineInput!) {
        subscriptionDraftLineAdd(draftId: $draftId, input: $input) {
          lineAdded { id }
          userErrors { field message }
        }
      }
    `, {
      draftId,
      input: {
        productVariantId: `gid://shopify/ProductVariant/${variantId}`,
        quantity,
      },
    });

    await commitDraft(shop, accessToken, draftId);
    return { success: true };
  } catch (err) {
    console.error("Add line item failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function removeLineItem(
  workspaceId: string,
  contractId: string,
  lineId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const draftId = await createDraft(shop, accessToken, contractId);

    const data = await shopifyGQL(shop, accessToken, `
      mutation subscriptionDraftLineRemove($draftId: ID!, $lineId: ID!) {
        subscriptionDraftLineRemove(draftId: $draftId, lineId: $lineId) {
          lineRemoved { id }
          userErrors { field message }
        }
      }
    `, { draftId, lineId });

    const result = data.subscriptionDraftLineRemove as { userErrors: { message: string }[] };
    if (result.userErrors?.length) throw new Error(result.userErrors[0].message);

    await commitDraft(shop, accessToken, draftId);
    return { success: true };
  } catch (err) {
    console.error("Remove line item failed:", err);
    return { success: false, error: String(err) };
  }
}

export async function updateLineItem(
  workspaceId: string,
  contractId: string,
  lineId: string,
  updates: { quantity?: number; variantId?: string },
): Promise<{ success: boolean; error?: string }> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const draftId = await createDraft(shop, accessToken, contractId);

    const input: Record<string, unknown> = {};
    if (updates.quantity !== undefined) input.quantity = updates.quantity;
    if (updates.variantId) input.productVariantId = `gid://shopify/ProductVariant/${updates.variantId}`;

    const data = await shopifyGQL(shop, accessToken, `
      mutation subscriptionDraftLineUpdate($draftId: ID!, $lineId: ID!, $input: SubscriptionLineUpdateInput!) {
        subscriptionDraftLineUpdate(draftId: $draftId, lineId: $lineId, input: $input) {
          lineUpdated { id }
          userErrors { field message }
        }
      }
    `, { draftId, lineId, input });

    const result = data.subscriptionDraftLineUpdate as { userErrors: { message: string }[] };
    if (result.userErrors?.length) throw new Error(result.userErrors[0].message);

    await commitDraft(shop, accessToken, draftId);
    return { success: true };
  } catch (err) {
    console.error("Update line item failed:", err);
    return { success: false, error: String(err) };
  }
}

// ── Next billing date change ──

export async function changeNextBillingDate(
  workspaceId: string,
  contractId: string,
  nextBillingDate: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const draftId = await createDraft(shop, accessToken, contractId);

    const data = await shopifyGQL(shop, accessToken, `
      mutation subscriptionDraftUpdate($draftId: ID!, $input: SubscriptionDraftInput!) {
        subscriptionDraftUpdate(draftId: $draftId, input: $input) {
          draft { id }
          userErrors { field message }
        }
      }
    `, {
      draftId,
      input: { nextBillingDate },
    });

    const result = data.subscriptionDraftUpdate as { userErrors: { message: string }[] };
    if (result.userErrors?.length) throw new Error(result.userErrors[0].message);

    await commitDraft(shop, accessToken, draftId);
    return { success: true };
  } catch (err) {
    console.error("Change next billing date failed:", err);
    return { success: false, error: String(err) };
  }
}
