/**
 * Known-resellers discovery — scans Amazon SP-API for every seller
 * competing on our ASINs, scrapes their public storefront for the
 * registered business name + address, and upserts into the
 * known_resellers table.
 *
 * Used by:
 *   - one-shot CLI script (scripts/discover-resellers.ts)
 *   - weekly cron (src/lib/inngest/reseller-discovery.ts)
 *
 * Read-only on Amazon. Writes to: known_resellers, fraud_action_log.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { spApiRequest } from "@/lib/amazon/auth";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

interface SellerProfile {
  amazonSellerId: string;
  businessName: string | null;
  addressLines: string[];
  asins: string[];
}

export interface ParsedAddress {
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string;
}

/**
 * Address shape on Amazon storefronts: each line is a separate
 * <span class="indent-left"> after "Business Address:". Typical layout:
 *   line 0: street
 *   line 1: street 2 (optional, sometimes a Unit/Apt/Ste)
 *   line 2: city
 *   line 3: state (full or abbreviation)
 *   line 4: zip (often with +4)
 *   line 5: country
 * We work backwards from the bottom: country, zip, state, city, then
 * everything above is the street(s).
 */
export function parseAddressLines(lines: string[]): ParsedAddress {
  const trimmed = lines.map(l => l.trim()).filter(Boolean);
  const result: ParsedAddress = { address1: null, address2: null, city: null, state: null, zip: null, country: "US" };
  if (!trimmed.length) return result;

  let working = [...trimmed];
  // Country
  if (/^US$|United States/i.test(working[working.length - 1])) {
    result.country = "US";
    working.pop();
  } else if (working.length > 0 && /^[A-Z]{2}$/.test(working[working.length - 1])) {
    result.country = working[working.length - 1];
    working.pop();
  }
  // Zip
  if (working.length > 0 && /\b\d{5}(-\d{4})?\b/.test(working[working.length - 1])) {
    result.zip = working[working.length - 1].match(/\b\d{5}(-\d{4})?\b/)![0];
    working.pop();
  }
  // State (full name or 2-letter)
  if (working.length > 0) {
    result.state = working[working.length - 1];
    working.pop();
  }
  // City
  if (working.length > 0) {
    result.city = working[working.length - 1];
    working.pop();
  }
  // Street: rest
  result.address1 = working[0] || null;
  result.address2 = working.length > 1 ? working.slice(1).join(", ") : null;
  return result;
}

/**
 * Normalize an address for SQL exact-equality matching. Strips the
 * common variations resellers use to obfuscate (extra dots, leading
 * zeroes, missing spaces, "Street" vs "St"). Used by the fraud rule
 * for the fast path before falling back to Haiku fuzzy match.
 */
export function normalizeReseller(addr: { address1?: string | null; zip?: string | null }): string {
  const street = (addr.address1 || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/^0+/, "")          // "010083" → "10083"
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\bsuite\b/g, "ste")
    .replace(/\bapartment\b/g, "apt")
    .replace(/\boval\b/g, "ovl")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const zip = (addr.zip || "").slice(0, 5);
  return `${street}|${zip}`;
}

export async function fetchSellerProfile(amazonSellerId: string): Promise<SellerProfile> {
  const url = `https://www.amazon.com/sp?seller=${amazonSellerId}`;
  const out: SellerProfile = { amazonSellerId, businessName: null, addressLines: [], asins: [] };
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
    });
    const html = await res.text();
    const nameMatch = html.match(/Business Name:\s*<\/span>\s*<span>([^<]+)<\/span>/);
    if (nameMatch) out.businessName = nameMatch[1].trim();

    const addrStart = html.indexOf("Business Address:");
    if (addrStart >= 0) {
      const after = html.slice(addrStart, addrStart + 2000);
      const lineRe = /class="a-row a-spacing-none indent-left"><span>([^<]+)<\/span>/g;
      let m: RegExpExecArray | null;
      while ((m = lineRe.exec(after)) !== null) out.addressLines.push(m[1].trim());
    }
  } catch {
    // swallow — caller will see empty businessName/addressLines
  }
  return out;
}

/**
 * For one workspace: walk every Amazon ASIN we sell, list competitors
 * via /products/pricing/v0/items/{asin}/offers, dedupe sellerIds,
 * scrape each storefront, upsert into known_resellers.
 */
export async function discoverResellers(workspaceId: string): Promise<{
  asinsScanned: number;
  sellersDiscovered: number;
  sellersUpdated: number;
}> {
  const admin = createAdminClient();
  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, marketplace_id, seller_id")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .maybeSingle();
  if (!conn) return { asinsScanned: 0, sellersDiscovered: 0, sellersUpdated: 0 };

  const ourSellerId = conn.seller_id as string;
  const mp = conn.marketplace_id as string;
  const connId = conn.id as string;

  // 1. List all our Amazon listings (paginated)
  const asins: string[] = [];
  let pageToken: string | null = null;
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({
      marketplaceIds: mp,
      pageSize: "20",
      includedData: "summaries",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await spApiRequest(connId, mp, "GET", `/listings/2021-08-01/items/${ourSellerId}?${params}`);
    if (!res.ok) break;
    const j = await res.json();
    for (const it of j.items || []) {
      const summary = (it.summaries || [])[0] || {};
      if (summary.asin) asins.push(summary.asin as string);
    }
    pageToken = j.pagination?.nextToken || null;
    if (!pageToken) break;
  }
  const uniqueAsins = [...new Set(asins)];

  // 2. For each ASIN, list competitor offers
  const sellerIdToAsins = new Map<string, Set<string>>();
  for (const asin of uniqueAsins) {
    const res = await spApiRequest(
      connId, mp, "GET",
      `/products/pricing/v0/items/${asin}/offers?MarketplaceId=${mp}&ItemCondition=New`,
    );
    if (!res.ok) {
      await new Promise(r => setTimeout(r, 600));
      continue;
    }
    const j = await res.json();
    for (const offer of j.payload?.Offers || []) {
      const sid = (offer as { SellerId: string }).SellerId;
      if (!sid || sid === ourSellerId) continue;
      if (!sellerIdToAsins.has(sid)) sellerIdToAsins.set(sid, new Set());
      sellerIdToAsins.get(sid)!.add(asin);
    }
    await new Promise(r => setTimeout(r, 600));
  }

  // 3. Scrape + upsert
  let discovered = 0;
  let updated = 0;
  for (const [sellerId, asinSet] of sellerIdToAsins.entries()) {
    const profile = await fetchSellerProfile(sellerId);
    const parsed = parseAddressLines(profile.addressLines);
    const normalized = parsed.address1 ? normalizeReseller({ address1: parsed.address1, zip: parsed.zip }) : null;

    // Existing?
    const { data: existing } = await admin
      .from("known_resellers")
      .select("id, status")
      .eq("workspace_id", workspaceId)
      .eq("platform", "amazon")
      .eq("amazon_seller_id", sellerId)
      .maybeSingle();

    const sourceAsins = [...asinSet];
    const row = {
      workspace_id: workspaceId,
      platform: "amazon",
      amazon_seller_id: sellerId,
      business_name: profile.businessName,
      address1: parsed.address1,
      address2: parsed.address2,
      city: parsed.city,
      state: parsed.state,
      zip: parsed.zip,
      country: parsed.country,
      normalized_address: normalized,
      source_asins: sourceAsins,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      // Update only the volatile fields; preserve status (admins may
      // have whitelisted manually).
      await admin.from("known_resellers")
        .update({
          business_name: row.business_name,
          address1: row.address1,
          address2: row.address2,
          city: row.city,
          state: row.state,
          zip: row.zip,
          country: row.country,
          normalized_address: row.normalized_address,
          source_asins: row.source_asins,
          last_seen_at: row.last_seen_at,
          updated_at: row.updated_at,
        })
        .eq("id", existing.id);
      updated++;
    } else {
      // New: status='unverified' so admins review before fraud rule
      // starts blocking. The CLI script can flip first batch to active.
      const { data: inserted } = await admin
        .from("known_resellers")
        .insert({ ...row, status: "unverified" })
        .select("id")
        .single();
      if (inserted) {
        await admin.from("fraud_action_log").insert({
          workspace_id: workspaceId,
          reseller_id: inserted.id,
          action: "reseller_discovered",
          metadata: {
            amazon_seller_id: sellerId,
            business_name: profile.businessName,
            asin_count: asinSet.size,
            asins: sourceAsins,
          },
        });
        discovered++;
      }
    }

    // Rate limit on Amazon storefront scrapes
    await new Promise(r => setTimeout(r, 1500));
  }

  // 4. Mark resellers that no longer compete on any of our ASINs as dormant
  const seenIds = [...sellerIdToAsins.keys()];
  if (seenIds.length > 0) {
    await admin.from("known_resellers")
      .update({ status: "dormant", updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId)
      .eq("platform", "amazon")
      .eq("status", "active")
      .not("amazon_seller_id", "in", `(${seenIds.map(id => `"${id}"`).join(",")})`);
  }

  return { asinsScanned: uniqueAsins.length, sellersDiscovered: discovered, sellersUpdated: updated };
}
