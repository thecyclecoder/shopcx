/**
 * POST /api/lead
 *
 * Lead capture endpoint. Any storefront surface (PDP popup,
 * customize-page save-cart, exit intent, footer form) hits this with:
 *
 *   {
 *     workspace_id:     required
 *     email:            required
 *     phone?:           optional (E.164)
 *     first_name?,
 *     last_name?:       optional
 *     email_consent:    bool
 *     sms_consent:      bool
 *     source:           free-form string (e.g. "customize_save_cart")
 *     anonymous_id?:    pixel session id — used for identity-stitch
 *   }
 *
 * Behavior:
 *   1. Match by email within the workspace; create the customers row if
 *      missing with subscription_status='never'.
 *   2. Refresh consent + names + phone.
 *   3. Stamp the anonymous_id → customer_id stitch on
 *      storefront_sessions + storefront_events, also enriching the
 *      session with device + IP-geo from the request headers.
 *   4. Append a storefront_leads row for funnel analytics.
 *
 * Returns: { customer_id, created: boolean }
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readVisitorContext, stitchVisitor } from "@/lib/identity-stitch";

interface Body {
  workspace_id?: string;
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  email_consent?: boolean;
  sms_consent?: boolean;
  source?: string;
  anonymous_id?: string | null;
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  if (!body.workspace_id) {
    return NextResponse.json({ error: "workspace_id required" }, { status: 400 });
  }
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }
  const email = body.email.trim().toLowerCase();
  const admin = createAdminClient();
  const ctx = readVisitorContext(request);

  // Match by email within workspace.
  let { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", body.workspace_id)
    .ilike("email", email)
    .maybeSingle();
  let created = false;
  if (!customer) {
    const { data: row, error } = await admin
      .from("customers")
      .insert({
        workspace_id: body.workspace_id,
        email,
        first_name: body.first_name || null,
        last_name: body.last_name || null,
        phone: body.phone || null,
        subscription_status: "never",
        email_marketing_status: body.email_consent ? "subscribed" : "not_subscribed",
        sms_marketing_status: body.sms_consent && body.phone ? "subscribed" : "not_subscribed",
      })
      .select("id")
      .single();
    if (error || !row) {
      return NextResponse.json({ error: error?.message || "customer_create_failed" }, { status: 500 });
    }
    customer = row;
    created = true;
  } else {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.first_name) updates.first_name = body.first_name;
    if (body.last_name) updates.last_name = body.last_name;
    if (body.phone) updates.phone = body.phone;
    if (typeof body.email_consent === "boolean") {
      updates.email_marketing_status = body.email_consent ? "subscribed" : "unsubscribed";
    }
    if (typeof body.sms_consent === "boolean" && body.phone) {
      updates.sms_marketing_status = body.sms_consent ? "subscribed" : "unsubscribed";
    }
    if (Object.keys(updates).length > 1) {
      await admin.from("customers").update(updates).eq("id", customer.id);
    }
  }

  // Stitch identity + enrich session.
  await stitchVisitor({
    workspaceId: body.workspace_id,
    customerId: customer.id,
    anonymousId: body.anonymous_id,
    context: ctx,
  });

  // Append to storefront_leads for capture-event analytics. Best-effort
  // (table may not exist on all workspaces yet); failures are non-fatal.
  await admin
    .from("storefront_leads")
    .insert({
      workspace_id: body.workspace_id,
      customer_id: customer.id,
      anonymous_id: body.anonymous_id || null,
      email,
      phone: body.phone || null,
      email_consent: !!body.email_consent,
      sms_consent: !!body.sms_consent,
      source: body.source || "unknown",
    })
    // Don't await an error response — table may not yet be migrated in
    // every workspace + the lead is already created on customers.
    .then(() => undefined, () => undefined);

  return NextResponse.json({ customer_id: customer.id, created });
}
