import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";

export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const admin = createAdminClient();

  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, portal_config, help_logo_url, help_primary_color")
    .eq("help_slug", slug)
    .single();

  if (!workspace) return notFound();

  const portalConfig = (workspace.portal_config || {}) as Record<string, unknown>;
  const minisite = (portalConfig.minisite || {}) as Record<string, unknown>;
  const logoUrl = (minisite.logo_url as string) || workspace.help_logo_url || "";
  const primaryColor = (minisite.primary_color as string) || workspace.help_primary_color || "#111827";

  return (
    <>
      <style>{`
        :root { --portal-primary: ${primaryColor}; }
        .portal-wrapper { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; color: #111827; min-height: 100vh; }
        .portal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; background: #fff; border-bottom: 1px solid #e5e7eb; }
        .portal-logo { height: 32px; }
        .portal-nav { display: flex; gap: 16px; align-items: center; }
        .portal-nav a { font-size: 14px; font-weight: 500; color: #6b7280; text-decoration: none; }
        .portal-nav a:hover { color: #111827; }
        .portal-body { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
      `}</style>
      <div className="portal-wrapper">
        <header className="portal-header">
          <div>
            {logoUrl ? <img src={logoUrl} alt={workspace.name} className="portal-logo" /> : <strong>{workspace.name}</strong>}
          </div>
          <nav className="portal-nav">
            <a href={`/portal/`}>Subscriptions</a>
            <a href={`/kb/`}>Help Center</a>
          </nav>
        </header>
        <main className="portal-body">
          {children}
        </main>
      </div>
    </>
  );
}
