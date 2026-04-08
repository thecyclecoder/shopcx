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
  const primaryColor = (minisite.primary_color as string) || workspace.help_primary_color || "#4f46e5";

  return (
    <>
      <style>{`
        :root { --portal-primary: ${primaryColor}; }
        .portal-wrapper { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; color: #111827; min-height: 100vh; }
        .portal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 24px; background: var(--portal-primary); }
        .portal-logo { height: 28px; filter: brightness(0) invert(1); }
        .portal-brand { color: #fff; font-size: 16px; font-weight: 700; white-space: nowrap; }
        .portal-nav { display: flex; gap: 16px; align-items: center; }
        .portal-nav a { font-size: 14px; font-weight: 500; color: rgba(255,255,255,0.85); text-decoration: none; }
        .portal-nav a:hover { color: #fff; }
        .portal-hamburger { display: none; background: none; border: none; color: #fff; cursor: pointer; padding: 4px; }
        .portal-mobile-menu { display: none; background: var(--portal-primary); padding: 0 24px 16px; }
        .portal-mobile-menu a { display: block; padding: 10px 0; font-size: 15px; font-weight: 500; color: rgba(255,255,255,0.9); text-decoration: none; border-top: 1px solid rgba(255,255,255,0.15); }
        .portal-mobile-menu.open { display: block; }
        .portal-body { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }
        @media (max-width: 600px) {
          .portal-nav { display: none; }
          .portal-hamburger { display: block; }
        }
      `}</style>
      <div className="portal-wrapper">
        <header>
          <div className="portal-header">
            <div>
              {logoUrl ? <img src={logoUrl} alt={workspace.name} className="portal-logo" /> : <span className="portal-brand">{workspace.name}</span>}
            </div>
            <nav className="portal-nav">
              <a href={`/portal/`}>Subscriptions</a>
              <a href={`/kb/`}>Help Center</a>
            </nav>
            <button className="portal-hamburger" id="portal-hamburger-btn" aria-label="Menu">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
            </button>
          </div>
          <div className="portal-mobile-menu" id="portal-mobile-menu">
            <a href={`/portal/`}>Subscriptions</a>
            <a href={`/kb/`}>Help Center</a>
          </div>
        </header>
        <script dangerouslySetInnerHTML={{ __html: `document.getElementById('portal-hamburger-btn')?.addEventListener('click',function(){document.getElementById('portal-mobile-menu')?.classList.toggle('open')})` }} />
        <main className="portal-body">
          {children}
        </main>
      </div>
    </>
  );
}
