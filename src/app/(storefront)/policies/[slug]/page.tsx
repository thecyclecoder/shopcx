/**
 * Storefront policy page — /policies/{slug}.
 *
 * Renders the customer-facing markdown from the `policies` table for the
 * active workspace. Source of truth is shared with the AI orchestrator —
 * when policy text is updated, both this public page AND the AI's
 * operating policy update in lockstep.
 *
 * Customer-facing ONLY. The `internal_summary` and `rules` fields exist
 * but are never rendered here.
 */
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { renderPolicyMarkdown } from "../_lib/markdown";

// Allowlist + nice display title fallback. We deliberately keep this fixed
// rather than rendering arbitrary slugs — these are the canonical 5 policies.
const VALID_SLUGS = ["returns", "refunds", "subscriptions", "exchanges", "crisis", "privacy", "terms"] as const;
type PolicySlug = typeof VALID_SLUGS[number];

// Display titles for cross-links. Names match what's in the policies table
// but kept here so the link block renders without a second DB call.
const POLICY_LINKS: { slug: PolicySlug; label: string }[] = [
  { slug: "subscriptions", label: "Subscriptions" },
  { slug: "returns", label: "Returns & Money-Back Guarantee" },
  { slug: "refunds", label: "Refunds" },
  { slug: "exchanges", label: "Exchanges & Replacements" },
  { slug: "crisis", label: "Out-of-Stock Substitutions" },
  { slug: "privacy", label: "Privacy Policy" },
  { slug: "terms", label: "Terms & Conditions" },
];

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

  const { data } = await admin
    .from("policies")
    .select("slug, name, customer_summary, version, effective_at, updated_at")
    .eq("workspace_id", ws.id)
    .eq("slug", slug)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? { ...data, workspace_name: ws.name } : null;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const policy = await loadPolicy(slug);
  if (!policy) return { title: "Policy not found" };
  return {
    title: `${policy.name} | ${policy.workspace_name}`,
    description: `${policy.workspace_name}'s ${policy.name.toLowerCase()}.`,
    robots: { index: true, follow: true },
  };
}

export default async function PolicyPage({ params }: PageProps) {
  const { slug } = await params;
  if (!VALID_SLUGS.includes(slug as PolicySlug)) return notFound();

  const policy = await loadPolicy(slug);
  if (!policy) return notFound();

  const html = renderPolicyMarkdown(policy.customer_summary);
  const updated = new Date(policy.updated_at).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  return (
    <main className="mx-auto max-w-3xl px-6 py-12 md:py-20">
      <nav className="mb-8 text-sm text-zinc-500">
        <a href="/" className="hover:text-zinc-900">Home</a>
        <span className="mx-2">/</span>
        <span>{policy.name}</span>
      </nav>
      <article
        className="policy-article"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      <section className="mt-16 border-t border-zinc-200 pt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 mb-4">Other Policies</h2>
        <ul className="space-y-2">
          {POLICY_LINKS.filter(l => l.slug !== slug).map(l => (
            <li key={l.slug}>
              <a
                href={`/policies/${l.slug}`}
                className="text-emerald-700 underline-offset-2 hover:underline"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </section>

      <footer className="mt-12 border-t border-zinc-200 pt-6 text-sm text-zinc-500">
        Last updated {updated}.{" "}
        <a href="mailto:support@superfoodscompany.com" className="text-emerald-700 underline-offset-2 hover:underline">
          Questions? Contact support.
        </a>
      </footer>
    </main>
  );
}
