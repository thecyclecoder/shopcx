import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { spApiRequest } from "@/lib/amazon/auth";

// GET: fetch all ASINs with current prices from Amazon
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Get active Amazon connection
  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, seller_id, marketplace_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .maybeSingle();

  if (!conn) return NextResponse.json({ error: "No Amazon connection" }, { status: 400 });

  // Get our synced ASINs
  const { data: asins } = await admin
    .from("amazon_asins")
    .select("id, asin, sku, title, image_url, status")
    .eq("amazon_connection_id", conn.id)
    .eq("status", "Active")
    .order("title", { ascending: true });

  if (!asins?.length) return NextResponse.json({ asins: [] });

  // Fetch current prices from Amazon for each ASIN
  const results: Array<{
    id: string;
    asin: string;
    sku: string;
    title: string;
    image_url: string | null;
    current_price: number | null;
    business_price: number | null;
    currency: string;
  }> = [];

  // Batch pricing lookups (max 20 per call)
  for (let i = 0; i < asins.length; i += 20) {
    const batch = asins.slice(i, i + 20);
    const skus = batch.map(a => a.sku).filter(Boolean);

    if (skus.length === 0) continue;

    try {
      // Use getListingOffers for each SKU
      for (const asin of batch) {
        if (!asin.sku) {
          results.push({ ...asin, current_price: null, business_price: null, currency: "USD" });
          continue;
        }

        try {
          const res = await spApiRequest(
            conn.id, conn.marketplace_id, "GET",
            `/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(asin.sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US&includedData=attributes`
          );

          if (res.ok) {
            const data = await res.json();
            const offers = data.attributes?.purchasable_offer || [];
            const mainOffer = offers[0];
            const ourPrice = mainOffer?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? null;
            const bizPrice = mainOffer?.business_price?.[0]?.schedule?.[0]?.value_with_tax ?? null;
            const currency = mainOffer?.currency ?? mainOffer?.our_price?.[0]?.schedule?.[0]?.currency ?? "USD";

            results.push({
              ...asin,
              current_price: ourPrice ? parseFloat(ourPrice) : null,
              business_price: bizPrice ? parseFloat(bizPrice) : null,
              currency: currency || "USD",
            });
          } else {
            // Try pricing API fallback
            const priceRes = await spApiRequest(
              conn.id, conn.marketplace_id, "GET",
              `/products/pricing/v0/price?MarketplaceId=${conn.marketplace_id}&Skus=${encodeURIComponent(asin.sku)}&ItemType=Sku`
            );
            if (priceRes.ok) {
              const priceData = await priceRes.json();
              const payload = priceData.payload?.[0];
              const landedPrice = payload?.Product?.Offers?.[0]?.BuyingPrice?.LandedPrice?.Amount;
              const listingPrice = payload?.Product?.Offers?.[0]?.BuyingPrice?.ListingPrice?.Amount;
              results.push({
                ...asin,
                current_price: listingPrice ? parseFloat(listingPrice) : (landedPrice ? parseFloat(landedPrice) : null),
                business_price: null,
                currency: "USD",
              });
            } else {
              results.push({ ...asin, current_price: null, business_price: null, currency: "USD" });
            }
          }
        } catch {
          results.push({ ...asin, current_price: null, business_price: null, currency: "USD" });
        }
      }
    } catch {
      for (const asin of batch) {
        results.push({ ...asin, current_price: null, business_price: null, currency: "USD" });
      }
    }
  }

  return NextResponse.json({
    asins: results,
    seller_id: conn.seller_id,
    marketplace_id: conn.marketplace_id,
  });
}

// POST: update prices
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const { updates } = body as { updates: Array<{ sku: string; price: number; business_price?: number }> };

  if (!updates?.length) return NextResponse.json({ error: "No updates" }, { status: 400 });

  const admin = createAdminClient();
  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, seller_id, marketplace_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .single();

  if (!conn) return NextResponse.json({ error: "No Amazon connection" }, { status: 400 });

  const results: Array<{ sku: string; success: boolean; error?: string }> = [];

  for (const update of updates) {
    try {
      // Business price must never be lower than standard price
      if (update.business_price && update.business_price < update.price) {
        results.push({ sku: update.sku, success: false, error: "Business price cannot be lower than standard price" });
        continue;
      }

      const patchBody: Record<string, unknown> = {
        productType: "PRODUCT",
        patches: [
          {
            op: "replace",
            path: "/attributes/purchasable_offer",
            value: [
              {
                marketplace_id: conn.marketplace_id,
                currency: "USD",
                our_price: [{ schedule: [{ value_with_tax: update.price }] }],
                ...(update.business_price ? {
                  business_price: [{ schedule: [{ value_with_tax: update.business_price }] }],
                } : {}),
              },
            ],
          },
        ],
      };

      const res = await spApiRequest(
        conn.id, conn.marketplace_id, "PATCH",
        `/listings/2021-08-01/items/${conn.seller_id}/${encodeURIComponent(update.sku)}?marketplaceIds=${conn.marketplace_id}&issueLocale=en_US`,
        patchBody,
      );

      if (res.ok) {
        const data = await res.json();
        const issues = data.issues?.filter((i: { severity: string }) => i.severity === "ERROR") || [];
        if (issues.length > 0) {
          results.push({ sku: update.sku, success: false, error: issues[0].message });
        } else {
          results.push({ sku: update.sku, success: true });
        }
      } else {
        const text = await res.text();
        results.push({ sku: update.sku, success: false, error: `API error ${res.status}: ${text.slice(0, 100)}` });
      }
    } catch (err) {
      results.push({ sku: update.sku, success: false, error: String(err).slice(0, 100) });
    }
  }

  return NextResponse.json({ results });
}
