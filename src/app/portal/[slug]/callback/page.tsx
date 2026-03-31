import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt } from "@/lib/crypto";

export default async function PortalCallback({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ customer_id?: string; email?: string; token?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;

  const customerId = query.customer_id;
  const email = query.email;

  if (!customerId || !email) {
    return redirect(`/portal/${slug}/login?error=invalid_callback`);
  }

  // Look up workspace
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id")
    .eq("help_slug", slug)
    .single();

  if (!workspace) return redirect(`/portal/${slug}/login?error=invalid_workspace`);

  // Verify customer exists in our DB
  const { data: customer } = await admin
    .from("customers")
    .select("id, shopify_customer_id")
    .eq("workspace_id", workspace.id)
    .eq("shopify_customer_id", customerId)
    .single();

  if (!customer) return redirect(`/portal/${slug}/login?error=customer_not_found`);

  // Create session cookie (24h expiry)
  const session = {
    shopify_customer_id: customer.shopify_customer_id,
    email,
    workspace_id: workspace.id,
    exp: Date.now() + 24 * 60 * 60 * 1000,
  };

  const cookieStore = await cookies();
  cookieStore.set("portal_session", encrypt(JSON.stringify(session)), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60,
    path: "/",
  });

  return redirect(`/portal/${slug}`);
}
