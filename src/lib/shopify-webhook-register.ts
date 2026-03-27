import { SHOPIFY_API_VERSION } from "@/lib/shopify";

const WEBHOOK_TOPICS = [
  "customers/create",
  "customers/update",
  "orders/create",
  "orders/updated",
  "disputes/create",
  "disputes/update",
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
      // 422 = already registered, that's fine
      if (res.status === 422) {
        registered.push(topic);
      } else {
        errors.push(`${topic}: ${JSON.stringify(data.errors || data)}`);
      }
    }
  }

  return { registered, errors };
}
