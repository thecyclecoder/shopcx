import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateInvestorMagicLink, isInvestorRole } from "@/lib/investors/auth";
import { sendInvestorLinkEmail } from "@/lib/email";

/**
 * POST /api/investors/request  { email }
 * Self-service "email me a fresh link" from the /investors/expired page. We look
 * up the customer; only investor|owner comp roles get a link. We ALWAYS return
 * ok:true (never reveal whether an email is on the investor list). The proxy
 * leaves /api/investors/* un-gated. See docs/brain/lifecycles/investors-area.md.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const email = String(body?.email ?? "").trim().toLowerCase();
  const generic = NextResponse.json({ ok: true });
  if (!email) return generic;

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, workspace_id, comp_role")
    .ilike("email", email)
    .maybeSingle();
  if (!customer || !isInvestorRole(customer.comp_role)) return generic; // silent no-op

  const link = generateInvestorMagicLink(customer.id, customer.email, customer.workspace_id);
  await sendInvestorLinkEmail({
    workspaceId: customer.workspace_id,
    toEmail: customer.email,
    link,
  }).catch(() => null);

  return generic;
}
