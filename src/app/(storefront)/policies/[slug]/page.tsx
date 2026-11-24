/**
 * Storefront policy page — /policies/{slug}.
 *
 * Renders the customer-facing markdown from the `policies` table for the
 * active workspace, via the policies SDK (`getPolicyCustomerFacing`). Source
 * of truth is shared with the AI orchestrator — when policy text is updated,
 * both this public page AND the AI's operating policy update in lockstep.
 *
 * Customer-facing ONLY. The `internal_summary` and `rules` fields exist
 * but are never rendered here (and never exceptions the team can grant —
 * the public page states the standard policy only).
 *
 * Look: shared legal-page design (peach title band, policy sidebar + "On this
 * page" contents, white text card, support box). Same design as the Shopify
 * theme's /policies/* pages — see legal.css.
 */
import { notFound } from "next/navigation";
import { cacheLife } from "next/cache";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPolicyCustomerFacing } from "@/lib/policies";
import { renderPolicyMarkdown } from "../_lib/markdown";
import "../_lib/legal.css";

// Allowlist + display labels. We deliberately keep this fixed rather than
// rendering arbitrary slugs. `label` is the sidebar name, `short` the mobile pill.
const POLICY_LINKS = [
  { slug: "returns", label: "Returns & Money-Back Guarantee", short: "Returns" },
  { slug: "refunds", label: "Refunds", short: "Refunds" },
  { slug: "subscriptions", label: "Subscriptions", short: "Subscriptions" },
  { slug: "exchanges", label: "Exchanges & Replacements", short: "Replacements" },
  { slug: "order-cancellation", label: "Order Cancellation", short: "Cancellation" },
  { slug: "crisis", label: "Out-of-Stock Substitutions", short: "Out of stock" },
  { slug: "privacy", label: "Privacy Policy", short: "Privacy" },
  { slug: "terms", label: "Terms & Conditions", short: "Terms" },
] as const;
type PolicySlug = typeof POLICY_LINKS[number]["slug"];
const VALID_SLUGS: readonly string[] = POLICY_LINKS.map((l) => l.slug);

const SUPPORT_EMAIL = "hello@superfoodscompany.com";

interface PageProps {
  params: Promise<{ slug: string }>;
}

async function loadPolicy(slug: string) {
  // Workspace resolution: in production, storefront serves a single brand
  // workspace. Until the multi-workspace storefront landing lands we read
  // the Superfoods workspace by name. When subdomain/customDomain routing
  // is wired up this becomes resolveWorkspaceFromHost(request).
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("name", "Superfoods Company")
    .single();
  if (!ws) return null;

  const policy = await getPolicyCustomerFacing(admin, ws.id, slug);
  return policy ? { ...policy, workspace_name: ws.name as string } : null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 });
  const { slug } = await params;
  if (!VALID_SLUGS.includes(slug)) return { title: "Policy not found" };
  const policy = await loadPolicy(slug);
  if (!policy) return { title: "Policy not found" };
  return {
    title: `${policy.name} | ${policy.workspace_name}`,
    description: `${policy.workspace_name}'s ${policy.name.toLowerCase()}.`,
    robots: { index: true, follow: true },
  };
}

export default async function PolicyPage({ params }: PageProps) {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 3600, expire: 3600 });
  const { slug } = await params;
  if (!VALID_SLUGS.includes(slug)) return notFound();

  const policy = await loadPolicy(slug as PolicySlug);
  if (!policy) return notFound();

  const { html, headings } = renderPolicyMarkdown(policy.customer_summary);
  const updated = new Date(policy.updated_at).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  return (
    <div className="lp">
      <div className="lp-brand">
        <a href="/">{policy.workspace_name}</a>
      </div>

      <section className="lp-hero">
        <span className="lp-eyebrow">Our policies</span>
        <h1>{policy.name}</h1>
        <div className="lp-meta">
          Last updated {updated} · <a href={`mailto:${SUPPORT_EMAIL}`}>Questions? We&apos;re here to help</a>
        </div>
      </section>

      <nav className="lp-pills" aria-label="Policies">
        {POLICY_LINKS.map((l) => (
          <a key={l.slug} href={`/policies/${l.slug}`} aria-current={l.slug === slug ? "page" : undefined}>
            {l.short}
          </a>
        ))}
      </nav>

      <div className="lp-wrap">
        <aside className="lp-side">
          <h4>Policies</h4>
          <ul className="lp-nav">
            {POLICY_LINKS.map((l) => (
              <li key={l.slug}>
                <a href={`/policies/${l.slug}`} aria-current={l.slug === slug ? "page" : undefined}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
          {headings.length > 1 && headings.length <= 12 && (
            <>
              <h4>On this page</h4>
              <ul className="lp-toc">
                {headings.map((h) => (
                  <li key={h.id}>
                    <a href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <main>
          <article className="lp-card">
            <div className="lp-body" dangerouslySetInnerHTML={{ __html: html }} />
          </article>
          <div className="lp-help">
            <div>
              <b>Still have a question?</b>
              <span>Our customer success team is happy to help.</span>
            </div>
            <a className="lp-btn" href={`mailto:${SUPPORT_EMAIL}`}>Contact support</a>
          </div>
        </main>
      </div>

      <p className="lp-foot">© {new Date().getFullYear()} {policy.workspace_name}. All rights reserved.</p>
    </div>
  );
}
