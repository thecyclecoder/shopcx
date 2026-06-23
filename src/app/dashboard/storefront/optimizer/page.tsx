"use client";

/**
 * Storefront Optimizer — the Growth control surface.
 *
 * The on/off switch + enforced product scope + the `auto_run_reversible` opt-in +
 * the editable guardrails the optimizer agent (M4) reads to bound every campaign.
 * OFF by default: while off the agent doesn't even propose. While on it proposes
 * campaigns as Build/Approve cards — the owner's tap runs each test
 * (docs/brain/specs/storefront-optimizer-activation-gate.md).
 *
 * Reads / writes /api/workspaces/[id]/storefront-optimizer-policy.
 */

import { useEffect, useState, useCallback } from "react";
import { useWorkspace } from "@/lib/workspace-context";

interface Policy {
  id: string | null;
  workspace_id: string;
  active: boolean;
  product_scope: string[];
  auto_run_reversible: boolean;
  max_concurrent_experiments: number;
  min_sample: number;
  holdout_pct: number;
  auto_rollback_ltv_tolerance: number;
  auto_rollback_windows: number;
  auto_rollback_refund_spike_delta: number;
  created_by: "agent" | "human";
  rationale: string | null;
  updated_at: string | null;
}

interface ProductOption {
  id: string;
  title: string;
  handle: string | null;
  published: boolean;
}

/** One pending campaign proposal card (mirrors the proposals API ProposalCard). */
interface ProposalCard {
  jobId: string;
  actionId: string;
  spec_slug: string;
  product_id: string;
  product_name: string | null;
  lander_type: string;
  audience: string;
  lever: string;
  hypothesis: string;
  reasoning: string;
  preview: string;
  variant: { kind: string; label: string; hero_prompt?: string; patch?: unknown };
  created_at: string | null;
  // optimizer-hero-preview-gate: 'concept' = approve the idea (a hero candidate is generated on approve);
  // 'preview' = a candidate hero is generated and awaiting image-approval (Approve live / Reject-with-notes).
  stage?: "concept" | "preview";
  preview_image_url?: string;
  preview_attempts?: { url: string; notes?: string; at: string }[];
}

export default function StorefrontOptimizerPage() {
  const workspace = useWorkspace();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [proposals, setProposals] = useState<ProposalCard[]>([]);
  const [proposalsLoaded, setProposalsLoaded] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/workspaces/${workspace.id}/storefront-optimizer-policy`);
    if (res.ok) {
      const data = await res.json();
      setPolicy(data.policy);
      setProducts(data.products ?? []);
    }
    setLoading(false);
  }, [workspace.id]);

  const loadProposals = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${workspace.id}/storefront-optimizer-proposals`);
    if (res.ok) {
      const data = await res.json();
      setProposals(Array.isArray(data.proposals) ? data.proposals : []);
    }
    setProposalsLoaded(true);
  }, [workspace.id]);

  useEffect(() => {
    load();
    loadProposals();
  }, [load, loadProposals]);

  // After a decision that re-surfaces the card (concept-approve generates a hero candidate; reject
  // regenerates it), the box worker runs async — re-poll a few times so the new preview shows up.
  const pollProposals = useCallback(() => {
    [3000, 8000, 16000, 28000].forEach((ms) => setTimeout(() => loadProposals(), ms));
  }, [loadProposals]);

  // The approve/decline/reject path goes through the EXISTING /api/roadmap/approve route
  // (approveRoadmapAction) — no new approval logic. On success we optimistically drop the card.
  // optimizer-hero-preview-gate: a hero campaign is two-stage — concept-approve generates a candidate,
  // then preview-approve goes live or reject-with-notes regenerates (the loop until the owner approves).
  const decide = useCallback(
    async (card: ProposalCard, decision: "approve" | "decline" | "reject", notes?: string) => {
      setDeciding(card.actionId);
      setError(null);
      const res = await fetch(`/api/roadmap/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: card.jobId, actionId: card.actionId, decision, notes }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setProposals((prev) => prev.filter((p) => p.actionId !== card.actionId));
        const isHeroConceptApprove = decision === "approve" && card.variant.kind === "hero" && card.stage !== "preview";
        if (decision === "decline") setToast("Proposal declined.");
        else if (decision === "reject") { setToast("Regenerating the hero with your notes — it'll re-appear for preview shortly."); pollProposals(); }
        else if (isHeroConceptApprove) { setToast("Generating a hero candidate — it'll re-appear for your image-approval shortly."); pollProposals(); }
        else setToast("Campaign queued — the agent is standing up the experiment.");
      } else {
        setError(data.error || "Failed to record your decision");
      }
      setDeciding(null);
    },
    [pollProposals],
  );

  const patch = useCallback(
    async (changes: Partial<Policy>) => {
      setSaving(true);
      setError(null);
      const res = await fetch(`/api/workspaces/${workspace.id}/storefront-optimizer-policy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPolicy(data.policy);
        setSavedAt(new Date().toLocaleTimeString());
      } else {
        setError(data.error || "Failed to save");
      }
      setSaving(false);
    },
    [workspace.id],
  );

  const toggleScope = (productId: string) => {
    if (!policy) return;
    const next = policy.product_scope.includes(productId)
      ? policy.product_scope.filter((id) => id !== productId)
      : [...policy.product_scope, productId];
    patch({ product_scope: next });
  };

  if (loading || !policy) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
        <p className="text-sm text-zinc-400">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">Storefront Optimizer</h1>
        <p className="mt-1 text-sm text-zinc-500">
          The control surface for the autonomous storefront optimizer. While off it does nothing.
          While on it <strong>proposes</strong> campaigns as Build/Approve cards — your tap runs each test.
        </p>
      </header>

      {error && (
        <div className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
          {error}
        </div>
      )}

      {toast && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-300">
          <span>{toast}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Master on/off ─────────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Optimizer is {policy.active ? "ON" : "OFF"}
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              {policy.active
                ? "The agent proposes campaigns (scoped below) as Build/Approve cards. Nothing runs on live traffic without your tap."
                : "The agent does not propose anything. Turn it on to start receiving campaign proposals."}
            </p>
          </div>
          <Toggle checked={policy.active} disabled={saving} onChange={(v) => patch({ active: v })} />
        </div>
      </section>

      {/* ── Product scope ─────────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Product scope</h2>
        <p className="mt-1 mb-3 text-xs text-zinc-500">
          The optimizer may only touch products on this allowlist — enforced, not advisory. A proposal for any
          other product is refused even if a lander exists.
        </p>
        {products.length === 0 ? (
          <p className="text-xs text-zinc-400">No products in this workspace.</p>
        ) : (
          <ul className="space-y-1.5">
            {products.map((p) => {
              const checked = policy.product_scope.includes(p.id);
              return (
                <li key={p.id}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving}
                      onChange={() => toggleScope(p.id)}
                      className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    <span className="text-sm text-zinc-900 dark:text-zinc-100">{p.title}</span>
                    {!p.published && (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-800">
                        draft
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ── auto_run_reversible opt-in ────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Auto-run reversible levers
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              When on, reversible copy/hero/chapter tests may run without the per-campaign tap. Offer and
              structural changes always stay approval-gated, regardless of this switch.
            </p>
          </div>
          <Toggle
            checked={policy.auto_run_reversible}
            disabled={saving}
            onChange={(v) => patch({ auto_run_reversible: v })}
          />
        </div>
      </section>

      {/* ── Proposed campaigns (Build/Approve cards) ──────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Proposed campaigns</h2>
        <p className="mt-1 mb-4 text-xs text-zinc-500">
          Each card is one hypothesis the agent formed from your funnel signal. For a copy/chapter test,
          approving stands up the experiment vs holdout. For a <strong>hero</strong> test you approve the
          concept first, then <strong>see the actual generated image</strong> and either approve it live or
          reject with notes to regenerate — nothing reaches live traffic on a prompt alone.
        </p>
        {!proposalsLoaded ? (
          <p className="text-xs text-zinc-400">Loading proposals…</p>
        ) : proposals.length === 0 ? (
          <p className="text-xs text-zinc-400">No proposals awaiting your approval.</p>
        ) : (
          <ul className="space-y-3">
            {proposals.map((card) => (
              <ProposalCardItem
                key={card.actionId}
                card={card}
                busy={deciding === card.actionId}
                disabled={deciding !== null}
                onApprove={() => decide(card, "approve")}
                onDecline={() => decide(card, "decline")}
                onReject={(notes) => decide(card, "reject", notes)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── Guardrails ────────────────────────────────────────────────── */}
      <section className="mb-6 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Guardrails</h2>
        <p className="mb-4 text-xs text-zinc-500">
          The bounded proxy the optimizer operates within. Percentages are fractions (0.10 = 10%).
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label="Max concurrent experiments"
            value={policy.max_concurrent_experiments}
            step={1}
            onCommit={(n) => patch({ max_concurrent_experiments: n })}
            disabled={saving}
          />
          <NumberField
            label="Min sample (per arm)"
            value={policy.min_sample}
            step={50}
            onCommit={(n) => patch({ min_sample: n })}
            disabled={saving}
          />
          <NumberField
            label="Holdout %"
            value={policy.holdout_pct}
            step={0.01}
            onCommit={(n) => patch({ holdout_pct: n })}
            disabled={saving}
          />
          <NumberField
            label="Auto-rollback LTV tolerance"
            value={policy.auto_rollback_ltv_tolerance}
            step={0.01}
            onCommit={(n) => patch({ auto_rollback_ltv_tolerance: n })}
            disabled={saving}
          />
          <NumberField
            label="Auto-rollback windows"
            value={policy.auto_rollback_windows}
            step={1}
            onCommit={(n) => patch({ auto_rollback_windows: n })}
            disabled={saving}
          />
          <NumberField
            label="Refund-spike delta"
            value={policy.auto_rollback_refund_spike_delta}
            step={0.01}
            onCommit={(n) => patch({ auto_rollback_refund_spike_delta: n })}
            disabled={saving}
          />
        </div>
      </section>

      <p className="text-xs text-zinc-400">
        {saving ? "Saving…" : savedAt ? `Saved at ${savedAt}.` : "Changes save automatically."}
      </p>
    </div>
  );
}

function ProposalCardItem({
  card,
  busy,
  disabled,
  onApprove,
  onDecline,
  onReject,
}: {
  card: ProposalCard;
  busy: boolean;
  disabled: boolean;
  onApprove: () => void;
  onDecline: () => void;
  onReject: (notes: string) => void;
}) {
  const isHero = card.variant.kind === "hero";
  // optimizer-hero-preview-gate: a hero campaign is in the image-preview stage once a candidate exists.
  const inPreview = isHero && card.stage === "preview" && !!card.preview_image_url;
  const [rejectOpen, setRejectOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const attempts = card.preview_attempts ?? [];

  return (
    <li className="rounded-md border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {card.lander_type || "lander"}
        </span>
        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          lever: {card.lever || "—"}
        </span>
        {card.audience && (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-500 dark:bg-zinc-800">
            {card.audience}
          </span>
        )}
        {inPreview && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            preview · approve to go live
          </span>
        )}
        {card.product_name && (
          <span className="ml-auto text-xs text-zinc-500">{card.product_name}</span>
        )}
      </div>

      {card.hypothesis && (
        <p className="mt-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">{card.hypothesis}</p>
      )}
      {card.reasoning && (
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{card.reasoning}</p>
      )}

      {inPreview ? (
        /* Image-preview stage — show the ACTUAL generated hero; approve it live or reject with notes. */
        <div className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={card.preview_image_url}
            alt="Generated hero candidate"
            className="w-full rounded-md border border-zinc-200 object-contain dark:border-zinc-800"
          />
          {attempts.length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Rejected attempts ({attempts.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {attempts.map((a, i) => (
                  <div key={i} className="w-20" title={a.notes || ""}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={a.url}
                      alt={`Rejected attempt ${i + 1}`}
                      className="h-20 w-20 rounded border border-zinc-200 object-cover opacity-70 dark:border-zinc-800"
                    />
                    {a.notes && (
                      <p className="mt-0.5 line-clamp-2 text-[9px] leading-tight text-zinc-400">{a.notes}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Concept stage — hero prompt for kind:'hero', content patch diff otherwise. */
        <div className="mt-3 rounded border border-zinc-100 bg-zinc-50 p-2.5 dark:border-zinc-800 dark:bg-zinc-900/50">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
            Variant{card.variant.label ? ` — ${card.variant.label}` : ""}
          </p>
          {isHero ? (
            <p className="text-xs text-zinc-600 dark:text-zinc-300">
              {card.variant.hero_prompt || "(hero — prompt pending)"}
            </p>
          ) : card.variant.patch ? (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-[11px] leading-snug text-zinc-600 dark:text-zinc-300">
              {JSON.stringify(card.variant.patch, null, 2)}
            </pre>
          ) : (
            <p className="text-xs text-zinc-400">(content patch)</p>
          )}
        </div>
      )}

      {inPreview && rejectOpen && (
        <div className="mt-3">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder='What to change? e.g. "warmer light", "show the pouch facing forward", "less busy background"'
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {inPreview ? (
          rejectOpen ? (
            <>
              <button
                type="button"
                disabled={disabled || !notes.trim()}
                onClick={() => onReject(notes.trim())}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-700 disabled:opacity-50"
              >
                {busy ? "Working…" : "Reject & regenerate"}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => { setRejectOpen(false); setNotes(""); }}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={onApprove}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? "Working…" : "Approve & go live"}
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setRejectOpen(true)}
                className="rounded-md border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-50 dark:border-amber-900/40 dark:text-amber-300 dark:hover:bg-amber-950/30"
              >
                Reject with notes
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={onDecline}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancel campaign
              </button>
            </>
          )
        ) : (
          <>
            <button
              type="button"
              disabled={disabled}
              onClick={onApprove}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? "Working…" : isHero ? "Approve concept → generate preview" : "Approve"}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={onDecline}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Decline
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
          checked ? "translate-x-5" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function NumberField({
  label,
  value,
  step,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  step: number;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => {
    setLocal(String(value));
  }, [value]);
  const commit = () => {
    const n = Number(local);
    if (Number.isFinite(n) && n !== value) onCommit(n);
    else setLocal(String(value));
  };
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
      <input
        type="number"
        step={step}
        value={local}
        disabled={disabled}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm tabular-nums dark:border-zinc-700 dark:bg-zinc-900"
      />
    </label>
  );
}
