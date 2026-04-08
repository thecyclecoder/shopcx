import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

export default async function PortalHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Check for portal session — support both magic link cookies and legacy portal_session
  const cookieStore = await cookies();
  const magicCustomerId = cookieStore.get("portal_customer_id")?.value;
  const magicWorkspaceId = cookieStore.get("portal_workspace_id")?.value;
  const legacySession = cookieStore.get("portal_session")?.value;

  let customerId: string | null = null;
  let workspaceId: string | null = null;

  if (magicCustomerId && magicWorkspaceId) {
    customerId = magicCustomerId;
    workspaceId = magicWorkspaceId;
  } else if (legacySession) {
    try {
      const session = JSON.parse(decrypt(legacySession));
      if (session && Date.now() <= session.exp) {
        // Look up customer by shopify_customer_id
        const admin2 = createAdminClient();
        const { data: cust } = await admin2.from("customers")
          .select("id, workspace_id")
          .eq("shopify_customer_id", session.shopify_customer_id)
          .limit(1).single();
        if (cust) {
          customerId = cust.id;
          workspaceId = cust.workspace_id;
        }
      }
    } catch { /* invalid session */ }
  }

  if (!customerId || !workspaceId) {
    return redirect(`/portal/${slug}/login`);
  }

  // Load workspace for portal config
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, shopify_myshopify_domain, portal_config")
    .eq("id", workspaceId)
    .single();

  if (!workspace) return redirect(`/portal/${slug}/login`);

  // Get shopify_customer_id for the portal JS
  const { data: custData } = await admin.from("customers")
    .select("shopify_customer_id")
    .eq("id", customerId)
    .single();
  const shopifyCustomerId = custData?.shopify_customer_id || "";
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
              logged_in_customer_id: "${shopifyCustomerId}",
              minisite: true
            };
          `,
        }}
      />
      <script src="/portal-assets/subscription-portal.js" defer />
    </div>
  );
}
