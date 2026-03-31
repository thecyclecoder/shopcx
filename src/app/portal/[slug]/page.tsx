import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

export default async function PortalHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Check for portal session
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get("portal_session")?.value;

  if (!sessionCookie) {
    return redirect(`/portal/${slug}/login`);
  }

  // Decrypt session
  let session: { shopify_customer_id: string; email: string; workspace_id: string; exp: number } | null = null;
  try {
    session = JSON.parse(decrypt(sessionCookie));
  } catch {
    return redirect(`/portal/${slug}/login`);
  }

  if (!session || Date.now() > session.exp) {
    return redirect(`/portal/${slug}/login`);
  }

  // Load workspace for portal config
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, shopify_myshopify_domain, portal_config")
    .eq("id", session.workspace_id)
    .single();

  if (!workspace) return redirect(`/portal/${slug}/login`);

  const shopDomain = workspace.shopify_myshopify_domain || "";

  return (
    <div>
      <h1 style={{ fontSize: "24px", fontWeight: 900, marginBottom: "16px" }}>Manage your subscriptions</h1>
      <div id="subscription-portal-root" />
      <link rel="stylesheet" href="/portal-assets/portal.min.css" />
      <script
        dangerouslySetInnerHTML={{
          __html: `
            window.__PORTAL_CONFIG__ = {
              endpoint: "/api/portal",
              shop: "${shopDomain}",
              logged_in_customer_id: "${session.shopify_customer_id}",
              minisite: true
            };
          `,
        }}
      />
      <script src="/portal-assets/subscription-portal.js" defer />
    </div>
  );
}
