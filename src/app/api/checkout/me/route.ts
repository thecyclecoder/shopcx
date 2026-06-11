/**
 * GET /api/checkout/me?cart_token=...
 *
 * Returns the authenticated customer (from the sx_session cookie) plus their
 * saved shipping addresses across the linked-account group. The checkout client
 * calls this on mount so that:
 *   - a page refresh after OTP re-hydrates authedCustomerId (the sub-mode
 *     chooser + saved-card picker depend on it), and
 *   - the shipping step can offer a "pick a saved address" list instead of
 *     forcing re-entry.
 *
 * { authed: false } when there's no valid session for the cart's workspace.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readSessionFromRequest } from "@/lib/auth-session";
import { linkGroupIds } from "@/lib/customer-links";

type Addr = {
  first_name?: string | null;
  last_name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province_code?: string | null;
  zip?: string | null;
  country_code?: string | null;
  phone?: string | null;
};

function addrKey(a: Addr): string {
  return [a.address1, a.address2, a.city, a.province_code, a.zip]
    .map((x) => (x || "").toString().trim().toLowerCase())
    .join("|");
}

export async function GET(request: NextRequest) {
  const cartToken = request.nextUrl.searchParams.get("cart_token");
  if (!cartToken) return NextResponse.json({ authed: false });

  const session = readSessionFromRequest(request);
  if (!session) return NextResponse.json({ authed: false });

  const admin = createAdminClient();
  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id")
    .eq("token", cartToken)
    .maybeSingle();
  if (!cart || cart.workspace_id !== session.w) return NextResponse.json({ authed: false });

  const { data: customer } = await admin
    .from("customers")
    .select("id, email, phone, first_name, last_name")
    .eq("id", session.c)
    .maybeSingle();
  if (!customer) return NextResponse.json({ authed: false });

  // Collect saved shipping addresses across the linked-account group — most
  // recent first, from orders + active subscriptions — deduped by address.
  const groupIds = await linkGroupIds(admin, session.w, session.c);
  const [{ data: orders }, { data: subs }] = await Promise.all([
    admin
      .from("orders")
      .select("shipping_address, created_at")
      .eq("workspace_id", session.w)
      .in("customer_id", groupIds)
      .not("shipping_address", "is", null)
      .order("created_at", { ascending: false })
      .limit(25),
    admin
      .from("subscriptions")
      .select("shipping_address, updated_at")
      .eq("workspace_id", session.w)
      .in("customer_id", groupIds)
      .not("shipping_address", "is", null)
      .order("updated_at", { ascending: false })
      .limit(25),
  ]);

  // Split a full "name" into first/last as a fallback.
  const splitName = (name?: string | null): { first: string | null; last: string | null } => {
    const parts = (name || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { first: null, last: null };
    if (parts.length === 1) return { first: parts[0], last: null };
    return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
  };

  const seen = new Set<string>();
  const addresses: Addr[] = [];
  // Only surface addresses complete enough to pass checkout validation
  // (street + city + state + zip). Name falls back to the customer's name so
  // the shipping form never ends up missing it.
  for (const row of [...(orders || []), ...(subs || [])]) {
    const a = (row.shipping_address as (Addr & { name?: string | null; province?: string | null })) || null;
    if (!a || !a.address1 || !a.zip || !a.city) continue;
    const province = a.province_code || (a.province && a.province.length === 2 ? a.province : null);
    if (!province) continue;
    const key = addrKey({ ...a, province_code: province });
    if (seen.has(key)) continue;
    seen.add(key);
    const nameFb = splitName(a.name);
    addresses.push({
      first_name: a.first_name || nameFb.first || (customer.first_name as string | null) || null,
      last_name: a.last_name || nameFb.last || (customer.last_name as string | null) || null,
      address1: a.address1 || null,
      address2: a.address2 || null,
      city: a.city || null,
      province_code: province,
      zip: a.zip || null,
      country_code: a.country_code || "US",
      phone: a.phone || null,
    });
  }

  return NextResponse.json({
    authed: true,
    customer: {
      id: customer.id,
      email: customer.email,
      phone: customer.phone,
      first_name: customer.first_name,
      last_name: customer.last_name,
    },
    addresses,
  });
}
