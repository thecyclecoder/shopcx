/**
 * Address fallback handler — fired by the order webhook when the
 * Shopify payload had neither shipping_address nor billing_address.
 * For subscription renewals Shopify often returns both as null on the
 * Order object; the fallback chain (see feedback_address_mirror_rule)
 * goes:
 *   1. Order.shippingAddress (already null here)
 *   2. Order.billingAddress  (already null here)
 *   3. Customer.defaultAddress  ← this handler tries this
 *
 * Read-only on Shopify; writes only to our orders table.
 */
import { inngest } from "./client";
import { createAdminClient } from "@/lib/supabase/admin";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

interface ShopifyAddr {
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string | null;
  city?: string;
  province?: string;
  provinceCode?: string;
  country?: string;
  countryCodeV2?: string;
  zip?: string;
  phone?: string | null;
}

function toSnake(a: ShopifyAddr | null | undefined): Record<string, unknown> | null {
  if (!a) return null;
  return {
    first_name: a.firstName ?? null,
    last_name: a.lastName ?? null,
    name: [a.firstName, a.lastName].filter(Boolean).join(" ") || null,
    address1: a.address1 ?? null,
    address2: a.address2 ?? null,
    city: a.city ?? null,
    province: a.province ?? null,
    province_code: a.provinceCode ?? null,
    country: a.country ?? null,
    country_code: a.countryCodeV2 ?? null,
    zip: a.zip ?? null,
    phone: a.phone ?? null,
  };
}

export const orderAddressFallback = inngest.createFunction(
  {
    id: "order-address-fallback",
    retries: 3,
    concurrency: [{ limit: 5, key: "event.data.workspaceId" }],
    triggers: [{ event: "orders/address-fallback" }],
  },
  async ({ event, step }) => {
    const { orderId, workspaceId } = event.data as { orderId: string; workspaceId: string };

    await step.run("backfill-address", async () => {
      const admin = createAdminClient();
      const { data: order } = await admin
        .from("orders")
        .select("id, shopify_order_id, shipping_address, billing_address")
        .eq("id", orderId)
        .single();
      if (!order) return { skipped: "no-order" };

      // If the address has already been filled by another path (fraud
      // check, retry, etc.) we have nothing to do.
      if (order.shipping_address || order.billing_address) {
        return { skipped: "already-filled" };
      }

      const { shop, accessToken } = await getShopifyCredentials(workspaceId);
      const gid = `gid://shopify/Order/${order.shopify_order_id}`;
      const query = `{
        order(id: "${gid}") {
          shippingAddress { firstName lastName address1 address2 city province provinceCode country countryCodeV2 zip phone }
          billingAddress  { firstName lastName address1 address2 city province provinceCode country countryCodeV2 zip phone }
          customer {
            defaultAddress { firstName lastName address1 address2 city province provinceCode country countryCodeV2 zip phone }
          }
        }
      }`;
      const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}`);
      const j = await res.json();
      const ord = j.data?.order;
      const ship = ord?.shippingAddress as ShopifyAddr | null;
      const bill = ord?.billingAddress as ShopifyAddr | null;
      const def = ord?.customer?.defaultAddress as ShopifyAddr | null;

      // Fallback chain
      const resolved = ship || bill || def || null;
      if (!resolved) return { skipped: "no-address-anywhere" };

      const snake = toSnake(resolved);
      const updates: Record<string, unknown> = {
        shipping_address: snake,
        billing_address: snake,
      };
      // If shipping happened to be populated upstream, prefer that for the shipping column
      if (ship) updates.shipping_address = toSnake(ship);
      if (bill) updates.billing_address = toSnake(bill);

      await admin.from("orders").update(updates).eq("id", orderId);
      return { filled: true, source: ship ? "order.shipping" : bill ? "order.billing" : "customer.default" };
    });
  },
);
