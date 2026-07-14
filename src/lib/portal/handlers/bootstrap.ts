import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
// Portal availability lever — some variants are IN STOCK but must not be
// selectable via any new-choice path (crisis: preserve inventory for existing
// renewers). Applied to the swap/add catalog here AND server-side in
// replaceVariants. See [[../mutation-guard]].
import { getSuppressedVariantIds } from "@/lib/portal/mutation-guard";

// Soft deadline for OPTIONAL bootstrap enrichments. The whole /api/portal
// Lambda is capped at Vercel's 30s ceiling (see src/app/api/portal/route.ts);
// a single slow read on catalog decoration or unlinked-account matching used
// to hold the entire response until Vercel hard-killed it, so customers saw a
// 30s timeout instead of a usable portal. Anything wrapped in
// withBootstrapTimeout returns a safe fallback (empty array / zero count) if
// it exceeds this budget — the core customer + config fields still ship.
export const PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS = 4000;

export async function withBootstrapTimeout<T>(
  work: Promise<T>,
  fallback: T,
  timeoutMs: number = PORTAL_BOOTSTRAP_OPTIONAL_TIMEOUT_MS,
): Promise<T> {
  return await new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export const bootstrap: RouteHandler = async ({ auth, route }) => {
  const admin = createAdminClient();

  // ── Core (essentials) reads run concurrently ──────────────────────────
  // customer identity + workspace portal_config are required for the payload
  // shape; they are NOT wrapped in withBootstrapTimeout — a slow core read
  // still fails the response, which is the correct behavior.
  const customerPromise =
    auth.workspaceId && auth.loggedInCustomerId
      ? admin
          .from("customers")
          .select("id, first_name, last_name, email, portal_banned")
          .eq("workspace_id", auth.workspaceId)
          .eq("shopify_customer_id", auth.loggedInCustomerId)
          .single()
          .then((r) => r.data as {
            id: string;
            first_name: string | null;
            last_name: string | null;
            email: string | null;
            portal_banned: boolean | null;
          } | null)
      : Promise.resolve(null);

  const workspacePromise = auth.workspaceId
    ? admin
        .from("workspaces")
        .select("portal_config, storefront_off_platform_review_count")
        .eq("id", auth.workspaceId)
        .single()
        .then((r) => r.data as {
          portal_config: unknown;
          storefront_off_platform_review_count: number | null;
        } | null)
    : Promise.resolve(null);

  const [customer, ws] = await Promise.all([customerPromise, workspacePromise]);

  const customerFirstName = customer?.first_name || "";
  const customerLastName = customer?.last_name || "";
  const customerEmail = customer?.email || "";
  const portalBanned = !!customer?.portal_banned;

  if (customer && auth.workspaceId) {
    // Log portal session — fire-and-forget, never blocks the response.
    logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.bootstrap",
      summary: "Portal session started",
    }).catch(() => {});
  }

  let portalConfig: Record<string, unknown> = {};
  // Off-platform base review count from the storefront settings, added to each
  // catalog product's count so the portal swap/add modal shows the same social
  // proof the customer saw on the PDP.
  let reviewBump = 0;
  if (ws?.portal_config && typeof ws.portal_config === "object") {
    portalConfig = ws.portal_config as Record<string, unknown>;
  }
  reviewBump = Number(ws?.storefront_off_platform_review_count) || 0;

  const general = (portalConfig.general || {}) as Record<string, unknown>;
  const productIds = Array.isArray(general.products_available_to_add)
    ? general.products_available_to_add.filter(Boolean)
    : [];
  const rawSpIds = Array.isArray(general.shipping_protection_product_ids)
    ? general.shipping_protection_product_ids
    : [];

  // ── Optional enrichments — each wrapped in withBootstrapTimeout ───────
  // A slow read here now degrades to an empty/zero fallback instead of
  // holding the Lambda until Vercel's 30s kill.

  // Active dunning cycles (count).
  const dunningCountPromise: Promise<number> =
    customer && auth.workspaceId
      ? withBootstrapTimeout(
          (async () => {
            const { count } = await admin
              .from("dunning_cycles")
              .select("id", { count: "exact", head: true })
              .eq("workspace_id", auth.workspaceId)
              .eq("customer_id", customer.id)
              .in("status", ["active", "skipped"]);
            return count || 0;
          })(),
          0,
        )
      : Promise.resolve(0);

  // Linked accounts count — two-hop read via customer_links.
  const linkedAccountCountPromise: Promise<number> = customer
    ? withBootstrapTimeout(
        (async () => {
          const { data: link } = await admin
            .from("customer_links")
            .select("group_id")
            .eq("customer_id", customer.id)
            .single();
          if (!link?.group_id) return 0;
          const { count: linkCount } = await admin
            .from("customer_links")
            .select("id", { count: "exact", head: true })
            .eq("group_id", link.group_id);
          return Math.max(0, (linkCount || 1) - 1);
        })(),
        0,
      )
    : Promise.resolve(0);

  // Product catalog for add/swap (from synced products table) + suppressed
  // variant decoration. The suppressed-variant read is intentionally inside the
  // same soft-deadline envelope — if it stalls, the whole catalog degrades
  // safely to empty instead of stalling the response.
  const catalogPromise: Promise<unknown[]> =
    productIds.length && auth.workspaceId
      ? withBootstrapTimeout(
          (async () => {
            const [{ data: products }, suppressed] = await Promise.all([
              admin
                .from("products")
                .select(
                  "id, shopify_product_id, title, handle, image_url, variants, rating, rating_count",
                )
                .eq("workspace_id", auth.workspaceId)
                .in("shopify_product_id", productIds),
              getSuppressedVariantIds(auth.workspaceId),
            ]);
            if (!products) return [] as unknown[];
            return products
              .map((p) => ({
                internalId: p.id,
                productId: p.shopify_product_id,
                title: p.title,
                handle: p.handle,
                image: { src: p.image_url || "", alt: p.title },
                rating: {
                  value: p.rating || 0,
                  count: (p.rating_count || 0) + reviewBump,
                },
                variants: (Array.isArray(p.variants) ? p.variants : []).filter(
                  (v: { id?: unknown; inventory_quantity?: number }) => {
                    if (suppressed.has(String(v.id ?? ""))) return false;
                    return v.inventory_quantity == null || v.inventory_quantity > 0;
                  },
                ),
              }))
              .filter((p) => (p.variants as unknown[]).length > 0);
          })(),
          [] as unknown[],
        )
      : Promise.resolve([] as unknown[]);

  // Shipping protection variant IDs — rawSpIds are Shopify PRODUCT IDs,
  // look up the actual (first-in-stock) variant IDs.
  const shippingProtectionVariantIdsPromise: Promise<string[]> =
    rawSpIds.length && auth.workspaceId
      ? withBootstrapTimeout(
          (async () => {
            const { data: spProducts } = await admin
              .from("products")
              .select("shopify_product_id, variants")
              .eq("workspace_id", auth.workspaceId)
              .in("shopify_product_id", rawSpIds);
            const out: string[] = [];
            if (spProducts) {
              for (const p of spProducts) {
                const variants = Array.isArray(p.variants) ? p.variants : [];
                for (const v of variants as {
                  id?: string;
                  inventory_quantity?: number;
                }[]) {
                  if (v.id) {
                    out.push(String(v.id));
                    break; // one variant per product
                  }
                }
              }
            }
            return out;
          })(),
          [] as string[],
        )
      : Promise.resolve([] as string[]);

  // Unlinked-account match candidates — expensive matcher over customers.
  type UnlinkMatch = {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    default_address: unknown;
  };
  const unlinkMatchesPromise: Promise<UnlinkMatch[]> =
    customer && auth.workspaceId
      ? withBootstrapTimeout(
          (async () => {
            const { findUnlinkedMatches } = await import("@/lib/account-matching");
            const rawMatches = await findUnlinkedMatches(
              auth.workspaceId!,
              customer.id,
              admin,
            );
            if (!rawMatches.length) return [] as UnlinkMatch[];
            const matchIds = rawMatches.map((m) => m.id).filter(Boolean);
            if (!matchIds.length) return [] as UnlinkMatch[];
            const { data: matchDetails } = await admin
              .from("customers")
              .select("id, email, first_name, last_name, default_address")
              .in("id", matchIds);
            return (matchDetails || []).map((m) => ({
              id: m.id,
              email: m.email,
              first_name: m.first_name,
              last_name: m.last_name,
              default_address: m.default_address,
            }));
          })(),
          [] as UnlinkMatch[],
        )
      : Promise.resolve([] as UnlinkMatch[]);

  const [
    dunningCount,
    linkedAccountCount,
    catalog,
    shippingProtectionVariantIds,
    unlinkMatches,
  ] = await Promise.all([
    dunningCountPromise,
    linkedAccountCountPromise,
    catalogPromise,
    shippingProtectionVariantIdsPromise,
    unlinkMatchesPromise,
  ]);

  return jsonOk({
    ok: true,
    shop: auth.shop,
    logged_in_customer_id: auth.loggedInCustomerId,
    route,
    dunning_count: dunningCount,
    linked_account_count: linkedAccountCount,
    banned: portalBanned,
    customer: {
      firstName: customerFirstName,
      lastName: customerLastName,
      email: customerEmail,
    },
    config: {
      lockDays: Number(general.lock_days) || 7,
      shippingProtectionProductIds: shippingProtectionVariantIds,
      catalog,
      rewardsUrl: String(general.rewards_url || ""),
    },
    unlinked_matches: unlinkMatches,
  });
};
