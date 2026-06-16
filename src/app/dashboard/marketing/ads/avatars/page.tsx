"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";

interface ArchetypeBrief {
  name?: string;
  wardrobe?: string;
  setting?: string;
  hook_delivery_style?: string;
  photoshoot_brief?: string;
}

interface DemographicBasis {
  cohort_size?: number;
  gender_share?: Record<string, number>;
  age_range_share?: Record<string, number>;
  life_stage_share?: Record<string, number>;
  income_bracket_share?: Record<string, number>;
  used_fallback_snapshot?: boolean;
}

interface Proposal {
  id: string;
  product_id: string;
  archetype_brief: ArchetypeBrief | null;
  demographic_basis: DemographicBasis | null;
  status: string;
  products?: { title?: string } | null;
}

interface Avatar {
  id: string;
  name: string;
  reference_image_urls: string[] | null;
  status: string;
  last_used_at: string | null;
  created_at: string;
}

function topShare(share: Record<string, number> | undefined): { label: string; pct: number } | null {
  if (!share) return null;
  const entries = Object.entries(share);
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  const [label, value] = entries[0];
  return { label, pct: Math.round(value * 100) };
}

function demographicLine(basis: DemographicBasis | null): string {
  if (!basis) return "Demographic basis unavailable";
  const gender = topShare(basis.gender_share);
  const age = topShare(basis.age_range_share);
  const parts: string[] = [];
  if (gender) parts.push(`${gender.pct}% ${gender.label}`);
  if (age) parts.push(`age ${age.label}`);
  let line = parts.length
    ? `This archetype represents ${parts.join(", ")}`
    : "This archetype is based on workspace demographics";
  if (typeof basis.cohort_size === "number") line += ` (cohort of ${basis.cohort_size})`;
  if (basis.used_fallback_snapshot) line += " — using workspace-wide demographics";
  return line + ".";
}

export default function AvatarsPage() {
  const workspace = useWorkspace();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [avatars, setAvatars] = useState<Avatar[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [pRes, aRes] = await Promise.all([
      fetch(`/api/ads/proposals?workspaceId=${workspace.id}`),
      fetch(`/api/ads/avatars?workspaceId=${workspace.id}`),
    ]);
    setProposals(pRes.ok ? await pRes.json() : []);
    setAvatars(aRes.ok ? await aRes.json() : []);
    setLoading(false);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function rejectProposal(id: string) {
    setBusy(id);
    await fetch(`/api/ads/proposals/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, status: "rejected" }),
    });
    setBusy(null);
    load();
  }

  async function archiveAvatar(id: string) {
    setBusy(id);
    await fetch(`/api/ads/avatars/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, status: "archived" }),
    });
    setBusy(null);
    load();
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Avatars</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Recurring on-brand characters for your ad creatives.
          </p>
        </div>
        <Link
          href="/dashboard/marketing/ads/avatars/proposals/new"
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Suggest avatars
        </Link>
      </div>

      {loading && <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>}

      {/* Proposals */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Proposals
        </h2>
        {!loading && proposals.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No proposals yet. Suggest avatars for a product to get started.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          {proposals.map((p) => {
            const brief = p.archetype_brief || {};
            return (
              <div
                key={p.id}
                className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="font-medium text-zinc-900 dark:text-zinc-100">
                      {brief.name || "Untitled archetype"}
                    </h3>
                    {p.products?.title && (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">{p.products.title}</p>
                    )}
                  </div>
                </div>
                <dl className="mt-3 space-y-1 text-sm text-zinc-600 dark:text-zinc-300">
                  {brief.wardrobe && (
                    <p>
                      <span className="font-medium text-zinc-500 dark:text-zinc-400">Wardrobe:</span>{" "}
                      {brief.wardrobe}
                    </p>
                  )}
                  {brief.setting && (
                    <p>
                      <span className="font-medium text-zinc-500 dark:text-zinc-400">Setting:</span>{" "}
                      {brief.setting}
                    </p>
                  )}
                </dl>
                <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                  {demographicLine(p.demographic_basis)}
                </p>
                <div className="mt-4 flex items-center gap-3">
                  <Link
                    href={`/dashboard/marketing/ads/avatars/new?proposalId=${p.id}`}
                    className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
                  >
                    Confirm + upload photos
                  </Link>
                  <button
                    onClick={() => rejectProposal(p.id)}
                    disabled={busy === p.id}
                    className="text-sm text-zinc-500 hover:text-zinc-700 disabled:opacity-50 dark:text-zinc-400 dark:hover:text-zinc-200"
                  >
                    Reject
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Active avatars */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Active avatars
        </h2>
        {!loading && avatars.length === 0 && (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No avatars yet.</p>
        )}
        <div className="space-y-3">
          {avatars.map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              {a.reference_image_urls?.[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={a.reference_image_urls[0]}
                  alt={a.name}
                  className="h-14 w-14 rounded-md object-cover"
                />
              ) : (
                <div className="h-14 w-14 rounded-md bg-zinc-100 dark:bg-zinc-800" />
              )}
              <div className="flex-1">
                <p className="font-medium text-zinc-900 dark:text-zinc-100">{a.name}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {a.last_used_at
                    ? `Last used ${new Date(a.last_used_at).toLocaleDateString()}`
                    : "Not used yet"}
                </p>
              </div>
              <button
                onClick={() => archiveAvatar(a.id)}
                disabled={busy === a.id}
                className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Archive
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
