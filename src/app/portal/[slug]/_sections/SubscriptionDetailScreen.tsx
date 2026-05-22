"use client";

/**
 * Subscription detail screen — every retention action lives here.
 *
 * Reads the contract from /api/portal?route=subscriptions (the list
 * endpoint already returns full contract shapes via
 * transformSubscription, including the new internal_id). Catalog for
 * add/swap comes from /api/portal?route=bootstrap.
 *
 * Action cards in this commit:
 *   - ItemsActionsCard with per-line disclosure (Change flavor /
 *     Swap product / Change quantity / Remove) and a top-level
 *     "Add item" CTA.
 *
 * Action cards landing in later commits:
 *   - PauseCard / ResumeCard / ReactivateCard
 *   - OrderActionsCard (order now / change date)
 *   - FrequencyCard
 *   - AddressCard
 *   - CouponCard
 *   - PaymentMethodCard
 *   - CancelCard
 *   - ShippingProtectionCard / RewardsCard / ReviewsCard
 */

import { useCallback, useEffect, useState } from "react";
import { ActionOverlay, type ActionPhase } from "../_components/ActionOverlay";

// ─────────────────────────────── types ──────────────────────────────

export interface ContractLine {
  id: string;
  title?: string;
  variantTitle?: string | null;
  quantity?: number;
  sku?: string | null;
  variantId?: string;
  productId?: string;
  variantImage?: { transformedSrc?: string } | null;
  currentPrice?: { amount?: string; currencyCode?: string };
  is_gift?: boolean;
}

export interface Contract {
  id: string;                  // shopify_contract_id (legacy)
  internal_id?: string;        // our UUID
  shopify_contract_id?: string;
  status: string;
  nextBillingDate?: string | null;
  billingPolicy?: { interval?: string; intervalCount?: number };
  billingInterval?: string;
  billingIntervalCount?: number;
  lines?: ContractLine[];
  appliedDiscounts?: Array<{ title?: string; value?: number; valueType?: string }>;
  shippingAddress?: Record<string, string> | null;
  is_internal?: boolean | null;
  portalState?: {
    bucket?: string;
    needsAttention?: boolean;
    recoveryStatus?: string | null;
  };
  crisisBanner?: { type?: string; message?: string } | null;
}

interface CatalogVariant {
  id: string;
  title?: string;
  inventory_quantity?: number | null;
  price_cents?: number;
  compare_at_price_cents?: number;
  price?: string;
  compare_at_price?: string;
  image?: { src?: string };
}

interface CatalogProduct {
  internalId?: string;
  productId?: string;
  title?: string;
  image?: { src?: string; alt?: string };
  rating?: { value?: number; count?: number };
  variants?: CatalogVariant[];
}

export type ActionApi = {
  startAction: () => void;
  completeAction: (description?: string) => void;
  failAction: (description?: string) => void;
};

interface Props {
  subscriptionId: string;
  workspace: { primaryColor: string };
}

// ─────────────────────────── main screen ────────────────────────────

export function SubscriptionDetailScreen({ subscriptionId, workspace }: Props) {
  const [contract, setContract] = useState<Contract | null>(null);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPhase, setActionPhase] = useState<ActionPhase>("idle");
  const [actionDescription, setActionDescription] = useState<string | undefined>(undefined);

  // Branded full-screen overlay — never a corner toast. See
  // feedback_portal_action_overlay memory.
  const action: ActionApi = {
    startAction: () => { setActionDescription(undefined); setActionPhase("loading"); },
    completeAction: (description) => { setActionDescription(description); setActionPhase("success"); },
    failAction: (description) => { setActionDescription(description); setActionPhase("error"); },
  };

  const loadContract = useCallback(async () => {
    const listRes = await fetch("/api/portal?route=subscriptions", { credentials: "same-origin" });
    if (!listRes.ok) throw new Error("Could not load subscriptions");
    const list = await listRes.json();
    const found = (list.contracts || []).find((c: { internal_id?: string; id?: string }) => {
      return c.internal_id === subscriptionId || c.id === subscriptionId;
    });
    if (!found) throw new Error("Subscription not found");
    setContract(found as Contract);
  }, [subscriptionId]);

  const loadCatalog = useCallback(async () => {
    try {
      const r = await fetch("/api/portal?route=bootstrap", { credentials: "same-origin" });
      if (!r.ok) return;
      const data = await r.json();
      if (Array.isArray(data?.catalog)) setCatalog(data.catalog as CatalogProduct[]);
    } catch { /* non-fatal — items card just disables add/swap */ }
  }, []);

  useEffect(() => {
    (async () => {
      setError(null);
      try {
        await Promise.all([loadContract(), loadCatalog()]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [loadContract, loadCatalog]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-6 w-32 animate-pulse rounded bg-zinc-100" />
        <div className="h-48 animate-pulse rounded-2xl bg-zinc-100" />
      </div>
    );
  }
  if (error || !contract) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6">
        <p className="text-sm font-semibold text-rose-800">Couldn&apos;t load this subscription</p>
        <p className="mt-1 text-xs text-rose-700">{error || "Unknown error"}</p>
        <a
          href="/subscriptions"
          onClick={(e) => { e.preventDefault(); window.location.href = "/subscriptions"; }}
          className="mt-3 inline-block text-sm font-semibold text-rose-700 underline"
        >
          ← Back to subscriptions
        </a>
      </div>
    );
  }

  const status = (contract.status || "").toLowerCase();
  const cadence = (() => {
    const interval = (contract.billingPolicy?.interval || contract.billingInterval || "month").toLowerCase();
    const count = contract.billingPolicy?.intervalCount || contract.billingIntervalCount || 1;
    return `Every ${count} ${interval}${count > 1 ? "s" : ""}`;
  })();
  const next = contract.nextBillingDate
    ? new Date(contract.nextBillingDate).toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", year: "numeric",
      })
    : null;
  const realLines = (contract.lines || []).filter((l) => !l.is_gift);
  const subtotalCents = realLines.reduce((s, l) => {
    const price = parseFloat(l.currentPrice?.amount || "0");
    return s + Math.round(price * 100) * (l.quantity || 1);
  }, 0);
  const isCancelled = status === "cancelled";

  return (
    <div className="space-y-5">
      <a
        href="/subscriptions"
        onClick={(e) => { e.preventDefault(); window.location.href = "/subscriptions"; }}
        className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500 hover:text-zinc-900"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        All subscriptions
      </a>

      {contract.crisisBanner?.message && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {contract.crisisBanner.message}
        </div>
      )}

      {contract.portalState?.needsAttention && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
          <p className="text-sm font-semibold text-rose-800">Action needed</p>
          <p className="mt-1 text-xs text-rose-700">
            We weren&apos;t able to process your most recent payment. Update your card to keep this subscription active.
          </p>
        </div>
      )}

      {/* Header */}
      <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
        <header className="flex flex-col gap-2 border-b border-zinc-100 p-5 sm:flex-row sm:items-baseline sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                {status === "paused" ? "Paused subscription" : isCancelled ? "Cancelled subscription" : "Next delivery"}
              </p>
              <StatusPill status={status} />
            </div>
            <p className="mt-0.5 text-lg font-semibold text-zinc-900">
              {status === "paused" ? "Resume anytime" : isCancelled ? "No upcoming charges" : next || "Date to be set"}
            </p>
          </div>
          <div className="text-left text-sm text-zinc-500 sm:text-right">
            <div>{cadence}</div>
            <div className="mt-0.5 font-medium text-zinc-700">
              ${(subtotalCents / 100).toFixed(2)} per delivery
            </div>
          </div>
        </header>
      </article>

      {/* Items + per-line actions */}
      <ItemsActionsCard
        contract={contract}
        catalog={catalog}
        isCancelled={isCancelled}
        primaryColor={workspace.primaryColor}
        onMutate={loadContract}
        action={action}
      />

      <ActionOverlay
        phase={actionPhase}
        description={actionDescription}
        onClose={() => setActionPhase("idle")}
      />
    </div>
  );
}

// ──────────────────────────── items card ────────────────────────────

function ItemsActionsCard({
  contract, catalog, isCancelled, primaryColor, onMutate, action,
}: {
  contract: Contract;
  catalog: CatalogProduct[];
  isCancelled: boolean;
  primaryColor: string;
  onMutate: () => Promise<void>;
  action: ActionApi;
}) {
  const [modal, setModal] = useState<
    | { type: "addSwap"; mode: "add" | "swap"; line?: ContractLine }
    | { type: "quantity"; line: ContractLine }
    | null
  >(null);
  const lines = (contract.lines || []).filter((l) => !l.is_gift);
  const canRemove = lines.length > 1;

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <header className="border-b border-zinc-100 p-5">
        <h3 className="text-base font-semibold text-zinc-900">Items</h3>
        <p className="mt-0.5 text-sm text-zinc-500">What&apos;s included in your subscription.</p>
      </header>

      <ul className="divide-y divide-zinc-100">
        {lines.map((ln) => (
          <li key={ln.id} className="p-4 sm:p-5">
            {isCancelled ? (
              <LineRow ln={ln} />
            ) : (
              <LineDisclosure
                ln={ln}
                catalog={catalog}
                canRemove={canRemove}
                contract={contract}
                primaryColor={primaryColor}
                onSwap={() => setModal({ type: "addSwap", mode: "swap", line: ln })}
                onQty={() => setModal({ type: "quantity", line: ln })}
                onMutate={onMutate}
                action={action}
              />
            )}
          </li>
        ))}
      </ul>

      {!isCancelled && catalog.length > 0 && (
        <div className="border-t border-zinc-100 bg-zinc-50 p-4">
          <button
            type="button"
            onClick={() => setModal({ type: "addSwap", mode: "add" })}
            className="w-full rounded-lg border border-dashed border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 hover:border-zinc-400 hover:text-zinc-900"
          >
            + Add item
          </button>
        </div>
      )}

      {modal?.type === "addSwap" && (
        <AddSwapModal
          contract={contract}
          catalog={catalog}
          mode={modal.mode}
          line={modal.line}
          primaryColor={primaryColor}
          onClose={() => setModal(null)}
          onDone={async () => { setModal(null); await onMutate(); }}
          action={action}
        />
      )}
      {modal?.type === "quantity" && (
        <QuantityModal
          contract={contract}
          line={modal.line}
          primaryColor={primaryColor}
          onClose={() => setModal(null)}
          onDone={async () => { setModal(null); await onMutate(); }}
          action={action}
        />
      )}
    </article>
  );
}

// ─────────────────────────── line components ────────────────────────

function LineRow({ ln }: { ln: ContractLine }) {
  const priceCents = Math.round(parseFloat(ln.currentPrice?.amount || "0") * 100) * (ln.quantity || 1);
  const img = ln.variantImage?.transformedSrc;
  return (
    <div className="flex items-center gap-4">
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={img} alt={ln.title || "Item"} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-zinc-900">
          {ln.title || "Item"}
          {ln.variantTitle && ln.variantTitle !== "Default Title" && (
            <span className="text-zinc-500"> — {ln.variantTitle}</span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">Qty {ln.quantity || 1}</div>
      </div>
      <div className="text-sm font-medium text-zinc-900">${(priceCents / 100).toFixed(2)}</div>
    </div>
  );
}

function LineDisclosure({
  ln, catalog, canRemove, contract, primaryColor, onSwap, onQty, onMutate, action,
}: {
  ln: ContractLine;
  catalog: CatalogProduct[];
  canRemove: boolean;
  contract: Contract;
  primaryColor: string;
  onSwap: () => void;
  onQty: () => void;
  onMutate: () => Promise<void>;
  action: ActionApi;
}) {
  const [open, setOpen] = useState(false);
  const [flavorOpen, setFlavorOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Find the matching catalog product. ln.productId may be either our
  // internal UUID or a Shopify product id — match either.
  const lnPid = String(ln.productId || "");
  const currentProduct = catalog.find(
    (p) => String(p.productId || "") === lnPid || String(p.internalId || "") === lnPid,
  );
  const flavorVariants = (currentProduct?.variants || []).filter(
    (v) =>
      String(v.id) !== String(ln.variantId) &&
      (v.inventory_quantity == null || (v.inventory_quantity || 0) > 0),
  );
  const hasFlavorOptions = flavorVariants.length > 0;

  async function callMutation(
    route: string,
    payload: Record<string, unknown>,
    okMsg: string,
    busyKey: string,
  ) {
    if (busy) return;
    setBusy(busyKey);
    action.startAction();
    try {
      const res = await fetch(`/api/portal?route=${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        return;
      }
      action.completeAction(okMsg);
      setOpen(false); setFlavorOpen(false);
      await onMutate();
    } catch {
      action.failAction();
    } finally {
      setBusy(null);
    }
  }

  const priceCents = Math.round(parseFloat(ln.currentPrice?.amount || "0") * 100) * (ln.quantity || 1);
  const img = ln.variantImage?.transformedSrc;

  return (
    <div>
      <div className="flex items-center gap-4">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={ln.title || "Item"} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-zinc-900">
            {ln.title || "Item"}
            {ln.variantTitle && ln.variantTitle !== "Default Title" && (
              <span className="text-zinc-500"> — {ln.variantTitle}</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-zinc-500">Qty {ln.quantity || 1}</div>
        </div>
        <div className="text-sm font-medium text-zinc-900">${(priceCents / 100).toFixed(2)}</div>
      </div>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="mt-3 flex w-full items-center justify-between rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
      >
        <span>{open ? "Hide" : "Make changes to this item"}</span>
        <svg className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-3 space-y-2 rounded-lg bg-zinc-50 p-3">
          {hasFlavorOptions && (
            <div>
              <DisclosureAction
                title="Change flavor"
                sub="Switch to another flavor of this product."
                disabled={busy === "flavor"}
                onClick={() => setFlavorOpen(!flavorOpen)}
              />
              {flavorOpen && (
                <div className="mt-2 grid grid-cols-2 gap-2 px-1 pb-1">
                  {flavorVariants.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      disabled={!!busy}
                      onClick={() =>
                        callMutation(
                          "replaceVariants",
                          {
                            contractId: contract.id,
                            oldLineId: ln.id,
                            newVariants: [{ variantId: String(v.id), quantity: ln.quantity || 1 }],
                            carryForwardDiscount: "EXISTING_PLAN",
                          },
                          `Switched to ${v.title}`,
                          "flavor",
                        )
                      }
                      className="rounded-md border border-zinc-200 bg-white px-2.5 py-2 text-xs font-medium text-zinc-700 hover:border-zinc-300"
                      style={busy === "flavor" ? { opacity: 0.5 } : undefined}
                    >
                      {v.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <DisclosureAction
            title="Swap product"
            sub="Replace with a different product."
            onClick={onSwap}
          />
          <DisclosureAction
            title="Change quantity"
            sub="Update how many you receive."
            onClick={onQty}
          />
          {canRemove && (
            <DisclosureAction
              title={busy === "remove" ? "Removing…" : "Remove"}
              sub="Remove this item from your subscription."
              danger
              disabled={!!busy}
              onClick={() =>
                callMutation(
                  "removeLineItem",
                  { contractId: contract.id, lineId: ln.id, variantId: ln.variantId },
                  "Item removed",
                  "remove",
                )
              }
            />
          )}
        </div>
      )}
      <input type="hidden" value={primaryColor} />
    </div>
  );
}

function DisclosureAction({
  title, sub, danger, disabled, onClick,
}: {
  title: string;
  sub: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`block w-full rounded-md border border-zinc-200 bg-white p-3 text-left transition hover:border-zinc-300 disabled:opacity-50 ${danger ? "hover:border-rose-300" : ""}`}
    >
      <div className={`text-sm font-semibold ${danger ? "text-rose-700" : "text-zinc-900"}`}>{title}</div>
      <div className="mt-0.5 text-xs text-zinc-500">{sub}</div>
    </button>
  );
}

// ─────────────────────────────── modals ─────────────────────────────

function ModalShell({
  title, onClose, children, footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-zinc-100 p-4">
          <h3 className="text-base font-semibold text-zinc-900">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-2 rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && (
          <footer className="flex flex-wrap gap-2 border-t border-zinc-100 bg-zinc-50 p-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

function variantImage(v?: CatalogVariant): string | null {
  const src = v?.image?.src;
  if (!src) return null;
  return src.includes("?") ? `${src}&width=800` : `${src}?width=800`;
}

function productImage(p?: CatalogProduct): string | null {
  const src = p?.image?.src;
  if (!src) return null;
  return src.includes("?") ? `${src}&width=800` : `${src}?width=800`;
}

function priceCentsFor(v?: CatalogVariant): { msrpCents: number | null; payCents: number | null } {
  if (!v) return { msrpCents: null, payCents: null };
  // Catalog passes prices as numeric *_cents or as dollar strings.
  const toCents = (raw: unknown): number | null => {
    if (raw == null) return null;
    const n = Number(raw);
    if (!isFinite(n)) return null;
    if (String(raw).includes(".") || n < 1000) return Math.round(n * 100);
    return Math.trunc(n);
  };
  const msrpCents = toCents(v.compare_at_price_cents) ?? toCents(v.compare_at_price)
    ?? toCents(v.price_cents) ?? toCents(v.price);
  if (msrpCents == null) return { msrpCents: null, payCents: null };
  const payCents = Math.round(msrpCents * 0.75);
  return { msrpCents, payCents };
}

function AddSwapModal({
  contract, catalog, mode, line, primaryColor, onClose, onDone, action,
}: {
  contract: Contract;
  catalog: CatalogProduct[];
  mode: "add" | "swap";
  line?: ContractLine;
  primaryColor: string;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  action: ActionApi;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [product, setProduct] = useState<CatalogProduct | null>(null);
  const [variant, setVariant] = useState<CatalogVariant | null>(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  const isSwap = mode === "swap";
  const linePid = String(line?.productId || "");
  const products = catalog
    .filter((p) =>
      !(isSwap && line && (String(p.productId || "") === linePid || String(p.internalId || "") === linePid)),
    )
    .filter((p) => (p.variants || []).some((v) => v.inventory_quantity == null || (v.inventory_quantity || 0) > 0));

  async function submit() {
    if (!variant || busy) return;
    setBusy(true);
    onClose();
    action.startAction();
    try {
      const payload: Record<string, unknown> = {
        contractId: contract.id,
        newVariants: [{ variantId: String(variant.id), quantity: qty }],
      };
      if (isSwap && line) {
        payload.oldLineId = line.id;
      }
      const res = await fetch("/api/portal?route=replaceVariants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        setBusy(false);
        return;
      }
      action.completeAction(isSwap ? "Item swapped" : "Item added");
      await onDone();
    } catch {
      action.failAction();
      setBusy(false);
    }
  }

  // Step 1: pick a product
  if (step === 1) {
    return (
      <ModalShell title={isSwap ? "Swap item" : "Add item"} onClose={onClose}>
        <p className="mb-3 text-sm text-zinc-600">
          {isSwap ? "Pick a different product, then choose your flavor." : "Pick a product, then choose your flavor and quantity."}
        </p>
        <ul className="space-y-2">
          {products.map((p) => {
            const img = productImage(p);
            return (
              <li key={p.productId || p.internalId}>
                <button
                  type="button"
                  onClick={() => {
                    setProduct(p);
                    setVariant((p.variants || []).find((v) => v.inventory_quantity == null || (v.inventory_quantity || 0) > 0) || null);
                    setStep(2);
                  }}
                  className="flex w-full items-center gap-3 rounded-lg border border-zinc-200 bg-white p-3 text-left hover:border-zinc-300"
                >
                  {img ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={img} alt={p.title} className="h-12 w-12 flex-shrink-0 rounded object-cover" />
                  ) : (
                    <div className="h-12 w-12 flex-shrink-0 rounded bg-zinc-100" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-zinc-900">{p.title}</div>
                    {p.rating?.value ? (
                      <div className="mt-0.5 text-xs text-amber-600">
                        ★ {p.rating.value.toFixed(2)}{" "}
                        <span className="text-zinc-500">({p.rating.count})</span>
                      </div>
                    ) : null}
                  </div>
                  <span className="text-xs font-semibold text-zinc-500">Select →</span>
                </button>
              </li>
            );
          })}
          {products.length === 0 && (
            <li className="rounded-lg bg-zinc-50 p-4 text-center text-sm text-zinc-500">
              No products available right now.
            </li>
          )}
        </ul>
      </ModalShell>
    );
  }

  // Step 2: variant + qty
  const variants = (product?.variants || []).filter((v) => v.inventory_quantity == null || (v.inventory_quantity || 0) > 0);
  const { msrpCents, payCents } = priceCentsFor(variant || undefined);
  const totalMsrp = (msrpCents || 0) * qty;
  const totalPay = (payCents || 0) * qty;
  const varImg = variantImage(variant || undefined) || productImage(product || undefined);

  return (
    <ModalShell
      title={isSwap ? "Swap item" : "Add item"}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            disabled={busy || !variant}
            onClick={submit}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: primaryColor }}
          >
            {busy ? "Saving…" : isSwap ? "Swap" : "Add to subscription"}
          </button>
          <button
            type="button"
            onClick={() => setStep(1)}
            disabled={busy}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:border-zinc-400 disabled:opacity-50"
          >
            Back
          </button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        {varImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={varImg} alt={product?.title || ""} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
        )}
        <div>
          <div className="text-sm font-semibold text-zinc-900">{product?.title}</div>
          {variant?.title && variant.title !== "Default Title" && (
            <div className="mt-0.5 text-xs text-zinc-500">{variant.title}</div>
          )}
        </div>
      </div>

      {variants.length > 1 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Flavor</div>
          <div className="flex flex-wrap gap-2">
            {variants.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setVariant(v)}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                  variant?.id === v.id
                    ? "border-zinc-900 bg-zinc-900 text-white"
                    : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400"
                }`}
              >
                {v.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Quantity</div>
        <select
          value={qty}
          onChange={(e) => setQty(Number(e.target.value) || 1)}
          className="w-24 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900"
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </div>

      {payCents != null && (
        <div className="rounded-lg bg-zinc-50 p-3">
          <div className="text-xs text-zinc-500">Price</div>
          <div className="mt-1 flex items-baseline gap-2">
            {msrpCents != null && totalMsrp > totalPay && (
              <span className="text-sm text-zinc-400 line-through">${(totalMsrp / 100).toFixed(2)}</span>
            )}
            <span className="text-lg font-bold text-zinc-900">${(totalPay / 100).toFixed(2)}</span>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-700">
              25% off
            </span>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function QuantityModal({
  contract, line, primaryColor, onClose, onDone, action,
}: {
  contract: Contract;
  line: ContractLine;
  primaryColor: string;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  action: ActionApi;
}) {
  const initial = line.quantity || 1;
  const [qty, setQty] = useState(initial);
  const [busy, setBusy] = useState(false);
  const img = line.variantImage?.transformedSrc || null;

  async function save() {
    if (qty === initial) { onClose(); return; }
    setBusy(true);
    onClose();
    action.startAction();
    try {
      const res = await fetch("/api/portal?route=replaceVariants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          contractId: contract.id,
          oldLineId: line.id,
          newVariants: [{ variantId: line.variantId, quantity: qty }],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        action.failAction(data?.message || data?.error || undefined);
        setBusy(false);
        return;
      }
      action.completeAction("Quantity updated");
      await onDone();
    } catch {
      action.failAction();
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title="Change quantity"
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            disabled={busy}
            onClick={save}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: primaryColor }}
          >
            {busy ? "Saving…" : "Submit"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 hover:border-zinc-400 disabled:opacity-50"
          >
            Cancel
          </button>
        </>
      }
    >
      <div className="mb-4 flex items-center gap-3">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={line.title || ""} className="h-14 w-14 flex-shrink-0 rounded-lg object-cover" />
        ) : (
          <div className="h-14 w-14 flex-shrink-0 rounded-lg bg-zinc-100" />
        )}
        <div>
          <div className="text-sm font-semibold text-zinc-900">{line.title || "Item"}</div>
          {line.variantTitle && line.variantTitle !== "Default Title" && (
            <div className="mt-0.5 text-xs text-zinc-500">{line.variantTitle}</div>
          )}
        </div>
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Quantity</div>
        <select
          value={qty}
          onChange={(e) => setQty(Number(e.target.value) || 1)}
          className="w-28 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm font-medium text-zinc-900"
        >
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </div>
    </ModalShell>
  );
}

// ─────────────────────────────── pills ──────────────────────────────

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "active"
      ? "bg-emerald-100 text-emerald-800"
      : status === "paused"
        ? "bg-amber-100 text-amber-800"
        : status === "cancelled"
          ? "bg-zinc-200 text-zinc-700"
          : "bg-zinc-100 text-zinc-700";
  const label = status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${tone}`}>
      {label}
    </span>
  );
}
