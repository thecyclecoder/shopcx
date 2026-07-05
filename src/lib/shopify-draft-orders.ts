// Shopify Draft Order creation for replacement orders
// Creates $0 draft orders using 100% discount, then completes them

import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

export interface ReplacementLineItem {
  variantId: string; // Shopify variant ID (numeric, not GID)
  title: string;
  quantity: number;
}

export interface ReplacementOrderInput {
  lineItems: ReplacementLineItem[];
  shippingAddress: {
    firstName: string;
    lastName: string;
    address1: string;
    address2?: string;
    city: string;
    province: string; // state code
    zip: string;
    country: string;
    phone?: string;
  };
  customerEmail: string;
  originalOrderNumber: string;
  reason: string;
  note?: string;
}

export interface CreatedDraftOrder {
  draftOrderId: string; // GID
  draftOrderName: string;
}

export interface CompletedReplacementOrder {
  draftOrderId: string;
  orderId: string; // GID
  orderName: string; // e.g. "SC126001"
  shopifyOrderId: string; // numeric
}

type GraphQLError = { message?: string; extensions?: { code?: string } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A top-level GraphQL error is a throttle if Shopify tagged it THROTTLED or the
 *  message mentions throttling. These are transient — the request is well-formed,
 *  Shopify just wants us to back off and retry. */
const isThrottleError = (errors: GraphQLError[] | undefined): boolean =>
  !!errors?.some(
    (e) => e.extensions?.code === "THROTTLED" || /throttl/i.test(e.message || ""),
  );

/**
 * POST a GraphQL query to Shopify with throttle-aware retries.
 *
 * Shopify signals overload two ways, both of which used to surface here as an
 * opaque failure: HTTP 429/5xx, and — more insidiously — HTTP 200 with a
 * top-level `errors` array (`{ extensions: { code: "THROTTLED" } }`) and NO
 * `data`. The old helper returned that 200 body verbatim, so callers saw
 * `data.draftOrderCreate === undefined` and threw a generic "returned no data"
 * with the real reason discarded. (This stranded a legitimate replacement on
 * ticket 332f4509 on 2026-07-03.)
 *
 * Now: retryable failures (429, 5xx, top-level THROTTLED) are retried with
 * exponential backoff. A NON-retryable top-level error is thrown with the real
 * Shopify message attached, so callers and logs see what actually happened
 * instead of "returned no data".
 */
async function shopifyGraphQL(
  shop: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const MAX_ATTEMPTS = 4;
  const BASE_DELAY_MS = 500;
  let lastRetryReason = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      },
    );

    // Retryable transport-level failures: rate limit (429) + transient 5xx.
    if (res.status === 429 || res.status >= 500) {
      lastRetryReason = `HTTP ${res.status}`;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      const text = await res.text();
      throw new Error(`Shopify GraphQL error after ${attempt} attempts: ${res.status} ${text}`);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify GraphQL error: ${res.status} ${text}`);
    }

    const body = (await res.json()) as Record<string, unknown>;
    const errors = body.errors as GraphQLError[] | undefined;

    if (errors?.length) {
      // Throttled → back off and retry (the request itself is valid).
      if (isThrottleError(errors)) {
        lastRetryReason = "THROTTLED";
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
      }
      // Non-throttle top-level error (or throttle after exhausting retries):
      // surface the real Shopify message rather than a downstream "no data".
      const detail = errors.map((e) => e.message || JSON.stringify(e)).join("; ");
      throw new Error(`Shopify GraphQL error: ${detail}`);
    }

    return body;
  }

  // Unreachable in practice — the loop either returns or throws — but keeps the
  // type checker happy and gives a sane message if MAX_ATTEMPTS ever hits 0.
  throw new Error(`Shopify GraphQL error: exhausted retries (${lastRetryReason || "unknown"})`);
}

/**
 * Create a $0 draft order for replacement items.
 * Uses 100% discount so no coupon codes are needed.
 */
export async function createReplacementDraftOrder(
  workspaceId: string,
  input: ReplacementOrderInput,
): Promise<CreatedDraftOrder> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const mutation = `
    mutation draftOrderCreate($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id
          name
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const note = input.note || `Replacement for ${input.originalOrderNumber} — ${input.reason}`;

  const variables = {
    input: {
      lineItems: input.lineItems.map((item) => ({
        variantId: `gid://shopify/ProductVariant/${item.variantId}`,
        quantity: item.quantity,
      })),
      appliedDiscount: {
        title: `Replacement — ${input.reason}`,
        valueType: "PERCENTAGE",
        value: 100,
      },
      shippingAddress: {
        firstName: input.shippingAddress.firstName,
        lastName: input.shippingAddress.lastName,
        address1: input.shippingAddress.address1,
        address2: input.shippingAddress.address2 || undefined,
        city: input.shippingAddress.city,
        provinceCode: input.shippingAddress.province,
        zip: input.shippingAddress.zip,
        countryCode: ["PR", "GU", "VI", "AS", "MP"].includes(input.shippingAddress.country) ? "US" : input.shippingAddress.country,
        phone: input.shippingAddress.phone || undefined,
      },
      email: input.customerEmail,
      note,
      tags: ["replacement", `replacement:${input.originalOrderNumber}`],
      shippingLine: {
        title: "Economy",
        price: "0.00",
      },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await shopifyGraphQL(shop, accessToken, mutation, variables)) as any;
  const data = result.data?.draftOrderCreate;

  if (data?.userErrors?.length) {
    throw new Error(`Draft order creation failed: ${data.userErrors.map((e: { message: string }) => e.message).join(", ")}`);
  }

  if (!data?.draftOrder?.id) {
    throw new Error(`Draft order creation returned no data: ${JSON.stringify(result).slice(0, 500)}`);
  }

  return {
    draftOrderId: data.draftOrder.id,
    draftOrderName: data.draftOrder.name,
  };
}

/**
 * Complete a draft order — converts it to a real order.
 */
export async function completeDraftOrder(
  workspaceId: string,
  draftOrderId: string,
): Promise<CompletedReplacementOrder> {
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const mutation = `
    mutation draftOrderComplete($id: ID!) {
      draftOrderComplete(id: $id) {
        draftOrder {
          id
          order {
            id
            name
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (await shopifyGraphQL(shop, accessToken, mutation, { id: draftOrderId })) as any;
  const data = result.data?.draftOrderComplete;

  if (data?.userErrors?.length) {
    throw new Error(`Draft order completion failed: ${data.userErrors.map((e: { message: string }) => e.message).join(", ")}`);
  }

  const order = data?.draftOrder?.order;
  if (!order?.id) {
    throw new Error(`Draft order completion returned no order: ${JSON.stringify(result).slice(0, 500)}`);
  }

  // Extract numeric ID from GID
  const shopifyOrderId = order.id.replace("gid://shopify/Order/", "");

  return {
    draftOrderId,
    orderId: order.id,
    orderName: order.name,
    shopifyOrderId,
  };
}

/**
 * Full flow: create draft + complete → returns the replacement order.
 */
export async function createAndCompleteReplacement(
  workspaceId: string,
  input: ReplacementOrderInput,
): Promise<CompletedReplacementOrder> {
  const draft = await createReplacementDraftOrder(workspaceId, input);
  return completeDraftOrder(workspaceId, draft.draftOrderId);
}
