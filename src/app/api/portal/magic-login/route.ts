import { NextResponse } from "next/server";
import { verifyMagicToken, generateMagicLinkURL } from "@/lib/magic-link";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";

// POST with token → verify + set session cookie + redirect
// POST with email → send magic link email
export async function POST(request: Request) {
  const body = await request.json();
  const admin = createAdminClient();

  // ── Magic token login ──
  if (body.token) {
    const payload = verifyMagicToken(body.token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid or expired login link. Please request a new one." }, { status: 401 });
    }

    // Verify customer exists
    const { data: customer } = await admin
      .from("customers")
      .select("id, email, first_name, shopify_customer_id")
      .eq("id", payload.customerId)
      .eq("workspace_id", payload.workspaceId)
      .single();

    if (!customer) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 });
    }

    // Set portal session cookie (24hr, same as token expiry)
    const cookieStore = await cookies();
    cookieStore.set("portal_customer_id", customer.id, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60,
      path: "/",
    });
    cookieStore.set("portal_workspace_id", payload.workspaceId, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60,
      path: "/",
    });

    return NextResponse.json({ success: true, redirectUrl: "/portal" });
  }

  // ── Email login → send magic link ──
  if (body.email) {
    const email = body.email.trim().toLowerCase();

    // Find workspace from referer or body
    let workspaceId = body.workspace_id;
    if (!workspaceId) {
      // Try to find from help_slug in referer
      const referer = request.headers.get("referer") || "";
      const hostMatch = referer.match(/https?:\/\/([^.]+)\.shopcx\.ai/);
      if (hostMatch) {
        const { data: ws } = await admin
          .from("workspaces")
          .select("id")
          .eq("help_slug", hostMatch[1])
          .single();
        workspaceId = ws?.id;
      }
    }

    if (!workspaceId) {
      // Fallback: find any workspace with this customer
      const { data: cust } = await admin
        .from("customers")
        .select("workspace_id")
        .eq("email", email)
        .limit(1)
        .single();
      workspaceId = cust?.workspace_id;
    }

    if (!workspaceId) {
      // Don't reveal if customer exists or not
      return NextResponse.json({ success: true, message: "If an account exists with that email, we'll send you a login link." });
    }

    // Find customer
    const { data: customer } = await admin
      .from("customers")
      .select("id, shopify_customer_id, email")
      .eq("workspace_id", workspaceId)
      .eq("email", email)
      .single();

    if (!customer) {
      return NextResponse.json({ success: true, message: "If an account exists with that email, we'll send you a login link." });
    }

    // Generate and send magic link
    const magicUrl = await generateMagicLinkURL(
      customer.id,
      customer.shopify_customer_id || "",
      customer.email,
      workspaceId,
    );

    // Send email
    const { sendTicketReply } = await import("@/lib/email");
    const { data: ws } = await admin
      .from("workspaces")
      .select("name")
      .eq("id", workspaceId)
      .single();

    await sendTicketReply({
      workspaceId,
      toEmail: email,
      subject: `Your login link — ${ws?.name || "Portal"}`,
      body: `<p>Hi there!</p><p>Click the button below to access your account:</p><p><a href="${magicUrl}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Log In to My Account</a></p><p>This link expires in 24 hours.</p><p>If you didn't request this, you can safely ignore this email.</p>`,
      inReplyTo: null,
      agentName: ws?.name || "Support",
      workspaceName: ws?.name || "",
    });

    return NextResponse.json({ success: true, message: "Check your email! We sent you a login link." });
  }

  return NextResponse.json({ error: "token or email required" }, { status: 400 });
}
