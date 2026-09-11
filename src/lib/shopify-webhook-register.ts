import { SHOPIFY_API_VERSION } from "@/lib/shopify";

const WEBHOOK_TOPICS = [
  "customers/create",
  "customers/update",
  "orders/create",
  "orders/updated",
  // NOTE: "fulfillments/update" was listed here and is NOT a valid Shopify topic — it does
  // not appear in the shop's allowed list, so it has never registered. The old 422-is-fine
  // branch reported it as registered anyway, which is how it survived. Removed rather than
  // corrected: fulfillment data already arrives via orders/updated + EasyPost (2,321 of 2,569
  // August orders carry fulfillments), so nothing was lost. `handleFulfillmentUpdate` in
  // shopify-webhooks.ts is consequently dead code — left in place pending a decision on
  // whether to wire "orders/fulfilled" or the fulfillment_orders/* family.
  "disputes/create",
  "disputes/update",
  // Vendor-side refund mirror. Without this topic, a refund issued in
  // the Shopify admin writes nothing to our order_refunds ledger — the
  // double-refund guard reads that ledger, so it goes blind on those
  // orders (28 of 69 fully-refunded orders under-reported as of
  // 2026-09-11). See src/lib/vendor-refund-mirror.ts +
  // handleRefundCreate in src/lib/shopify-webhooks.ts.
  "refunds/create",
  // Subscription billing outcomes. REST topic names, NOT the GraphQL enum
  // (SUBSCRIPTION_BILLING_ATTEMPTS_SUCCESS) — a wrong name comes back 422, which the loop
  // below used to count as "already registered". Required before ShopCX can own billing:
  // dunning's only failure trigger today is Appstle's relay, so removing Appstle without
  // these registered stops dunning SILENTLY.
  "subscription_billing_attempts/success",
  "subscription_billing_attempts/failure",
  "subscription_billing_attempts/challenged",
];

export async function registerShopifyWebhooks(
  shop: string,
  accessToken: string,
  callbackUrl: string
): Promise<{ registered: string[]; errors: string[] }> {
  const registered: string[] = [];
  const errors: string[] = [];

  for (const topic of WEBHOOK_TOPICS) {
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          webhook: {
            topic,
            address: callbackUrl,
            format: "json",
          },
        }),
      }
    );

    if (res.ok) {
      registered.push(topic);
    } else {
      const data = await res.json();
      // 422 usually means "already registered" — but an INVALID topic name returns 422 too,
      // so treating it as success silently swallows a typo and leaves the webhook unregistered
      // while reporting green. Verify against the live list instead of trusting the status.
      if (res.status === 422) {
        const check = await fetch(
          `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json?topic=${encodeURIComponent(topic)}`,
          { headers: { "X-Shopify-Access-Token": accessToken } },
        );
        const live = check.ok ? await check.json() : { webhooks: [] };
        if ((live.webhooks ?? []).length > 0) {
          registered.push(topic);
        } else {
          errors.push(`${topic}: 422 and NOT present on the shop — likely an invalid topic name (${JSON.stringify(data.errors || data)})`);
        }
      } else {
        errors.push(`${topic}: ${JSON.stringify(data.errors || data)}`);
      }
    }
  }

  return { registered, errors };
}
