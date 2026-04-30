import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// CORS — this endpoint is meant to be embedded on Shopify storefronts
// (via the contact-form theme block) and on the help-center subdomain.
// Both are cross-origin from shopcx.ai, so allow * — the endpoint
// requires a valid help_slug anyway, and creates tickets which is the
// intended public surface.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// POST: Create a ticket from the public help center — no auth required
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const admin = createAdminClient();

  // Find workspace
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("help_slug", slug)
    .single();

  if (!workspace) return NextResponse.json({ error: "Help center not found" }, { status: 404, headers: CORS_HEADERS });

  const body = await request.json();
  const { email, subject, message, category } = body;

  if (!email || !message) {
    return NextResponse.json({ error: "Email and message required" }, { status: 400, headers: CORS_HEADERS });
  }

  // Find or create customer
  let customerId: string | null = null;
  const { data: existing } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspace.id)
    .eq("email", email.toLowerCase())
    .single();

  if (existing) {
    customerId = existing.id;
  } else {
    const { data: created } = await admin
      .from("customers")
      .insert({ workspace_id: workspace.id, email: email.toLowerCase() })
      .select("id")
      .single();
    customerId = created?.id || null;
  }

  // Create ticket — channel is "email" since the only contact info we
  // have is email and that's how we'll reply. The "contact-form" tag
  // marks the source (vs a customer who emailed us directly), and
  // smart:{category} preserves any topic dropdown selection.
  const tags: string[] = ["contact-form"];
  if (category) tags.push(`smart:${category}`);

  const { data: ticket, error } = await admin
    .from("tickets")
    .insert({
      workspace_id: workspace.id,
      customer_id: customerId,
      channel: "email",
      status: "open",
      subject: subject || `Help request from ${email}`,
      tags,
      last_customer_reply_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500, headers: CORS_HEADERS });

  // Add the message
  if (ticket) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticket.id,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body: message,
    });

    // Unified handler handles routing
    await inngest.send({
      name: "ticket/inbound-message",
      data: { workspace_id: workspace.id, ticket_id: ticket.id, message_body: message, channel: "email", is_new_ticket: true },
    });
  }

  return NextResponse.json(
    { ticket_id: ticket?.id, message: "Your request has been submitted! We'll get back to you shortly." },
    { headers: CORS_HEADERS },
  );
}
