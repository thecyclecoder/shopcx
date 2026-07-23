/**
 * POST /api/checkout/identify
 *
 * Pre-checkout customer identification — fires when the email +
 * (optionally) phone fields on the checkout page are valid, BEFORE
 * the customer submits. Lets us:
 *
 *   - Create the customers row early so abandoned-cart messaging
 *     has someone to message.
 *   - Match an existing customer by email (across linked accounts)
 *     and reuse their record.
 *   - Stash marketing consent on the customer (and the cart).
 *   - Identity-stitch the cart's anonymous_id → customer_id so events
 *     fired between identify and submit get attributed correctly.
 *
 * Body shape:
 *   {
 *     cart_token:               required
 *     email:                    required
 *     phone?:                   optional
 *     first_name?, last_name?:  optional
 *     email_marketing_consent?: bool, default true (UI sends explicit)
 *     sms_marketing_consent?:   bool, default true
 *   }
 *
 * Returns:
 *   { customer_id, created: boolean }
 *
 * Idempotent — repeated calls with the same cart_token + email
 * resolve to the same customer and just refresh consent fields.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { readVisitorContext, stitchVisitor } from "@/lib/identity-stitch";
import { toE164US } from "@/lib/phone";

interface Body {
  cart_token?: string;
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  email_marketing_consent?: boolean;
  sms_marketing_consent?: boolean;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  if (!body.cart_token) return NextResponse.json({ error: "cart_token required" }, { status: 400 });
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();

  const admin = createAdminClient();

  const { data: cart } = await admin
    .from("cart_drafts")
    .select("workspace_id, status, customer_id, anonymous_id")
    .eq("token", body.cart_token)
    .maybeSingle();
  if (!cart) return NextResponse.json({ error: "cart_not_found" }, { status: 404 });
  if (cart.status !== "open") return NextResponse.json({ error: "cart_not_open" }, { status: 400 });

  // Persist phone canonically as E.164 — the UI re-formats it for display, so
  // storage stays consistent (avoids clobbering a verified number with a
  // display-formatted one). Falls back to the raw value if it can't parse.
  const phoneE164 = body.phone ? (toE164US(body.phone) || body.phone) : null;

  // Match by email within the workspace.
  let { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", cart.workspace_id)
    .ilike("email", email)
    .maybeSingle();
  let created = false;
  if (!customer) {
    // Get-or-create is non-atomic (check-then-insert): two concurrent requests
    // for the same new email both miss the select above and both try to insert,
    // and the loser hits the UNIQUE(workspace_id, email) constraint (Postgres
    // 23505). Upsert with ignoreDuplicates so the loser inserts nothing (returns
    // no row) instead of throwing; then re-read the winner's row by (ws, email).
    const { data: row, error } = await admin
      .from("customers")
      .upsert({
        workspace_id: cart.workspace_id,
        email,
        first_name: body.first_name || null,
        last_name: body.last_name || null,
        phone: phoneE164,
        subscription_status: "never",
        email_marketing_status: body.email_marketing_consent ? "subscribed" : "not_subscribed",
        sms_marketing_status: body.sms_marketing_consent && body.phone ? "subscribed" : "not_subscribed",
      }, { onConflict: "workspace_id,email", ignoreDuplicates: true })
      .select("id")
      .maybeSingle();
    if (error) {
      // Log the full PostgREST diagnostic server-side; never return
      // error.message / code / details / hint to the client on the
      // public identify endpoint (same class as client-token 500).
      console.error(
        `[checkout/identify] customers upsert failed for workspace ${cart.workspace_id} email ${email}: ${errText(error)}`,
      );
      return NextResponse.json({ error: "customer_create_failed" }, { status: 500 });
    }
    if (row) {
      customer = row;
      created = true;
    } else {
      // Lost the insert race — the row already exists, so re-read it.
      const { data: existing } = await admin
        .from("customers")
        .select("id")
        .eq("workspace_id", cart.workspace_id)
        .eq("email", email)
        .maybeSingle();
      if (!existing) return NextResponse.json({ error: "customer_create_failed" }, { status: 500 });
      customer = existing;
    }
  } else {
    // Refresh names + phone + marketing consent on the existing row.
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.first_name) updates.first_name = body.first_name;
    if (body.last_name) updates.last_name = body.last_name;
    if (phoneE164) updates.phone = phoneE164;
    if (typeof body.email_marketing_consent === "boolean") {
      updates.email_marketing_status = body.email_marketing_consent ? "subscribed" : "unsubscribed";
    }
    if (typeof body.sms_marketing_consent === "boolean" && body.phone) {
      updates.sms_marketing_status = body.sms_marketing_consent ? "subscribed" : "unsubscribed";
    }
    if (Object.keys(updates).length > 1) {
      await admin.from("customers").update(updates).eq("id", customer.id);
    }
  }

  // Stamp the cart with the customer id + email/phone so subsequent
  // page reloads + the eventual /api/checkout call see them.
  await admin
    .from("cart_drafts")
    .update({
      customer_id: customer.id,
      email,
      phone: phoneE164,
      updated_at: new Date().toISOString(),
    })
    .eq("token", body.cart_token);

  // Stitch the anonymous_id → customer_id on storefront_sessions /
  // _events + enrich the session with device + IP-geo. Backfills any
  // pre-identify pixel events with the customer_id so funnel queries
  // attribute correctly.
  await stitchVisitor({
    workspaceId: cart.workspace_id as string,
    customerId: customer.id,
    anonymousId: (cart.anonymous_id as string | null) || null,
    context: readVisitorContext(request),
  });

  return NextResponse.json({ customer_id: customer.id, created });
}
