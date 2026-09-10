/**
 * ShopCX's own Shopify subscription client — the replacement for `appstle.ts`.
 *
 * Appstle is a wrapper around these same Shopify APIs plus a scheduler and a UI, so this module
 * deliberately mirrors `appstle.ts`'s function signatures: swapping a caller should be an import
 * change, not a rewrite. See docs/brain/lifecycles/shopcx-subscriptions.md.
 *
 * ⭐ Two things that are NOT like Appstle, and drive everything here:
 *
 *  1. **Shopify fires nothing.** It stores `billingPolicy` and computes cycles, but never charges
 *     and never advances `nextBillingDate` — verified on a live contract. The scheduler is ours.
 *  2. **The contract IS the charge.** Shopify builds the order from the contract, so every
 *     mutation must round-trip here; anything living only in our mirror is cosmetic.
 *
 * Draft-based edits share one envelope — `subscriptionContractUpdate` → mutate → `commit` — which
 * `withDraft` owns. Batch related edits into ONE draft: a quantity change and its quantity-break
 * discount must commit together, or a charge landing between them bills the wrong amount.
 *
 * Note the draft mutations do NOT appear in the introspected `Mutation` field list (scope-filtered)
 * but do execute. Probe by calling, never by introspecting.
 */
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { errText } from "@/lib/error-text";

export interface SubscriptionActionResult {
  success: boolean;
  error?: string;
}

/** Shopify wants a GID; our mirror stores the bare numeric id. Accept either. */
export function contractGid(contractId: string): string {
  return String(contractId).startsWith("gid://")
    ? String(contractId)
    : `gid://shopify/SubscriptionContract/${contractId}`;
}
function variantGid(variantId: string): string {
  return String(variantId).startsWith("gid://")
    ? String(variantId)
    : `gid://shopify/ProductVariant/${variantId}`;
}

interface GqlResult<T> { data?: T; errors?: { message: string }[] }

/** One Admin GraphQL call. Returns the raw envelope so callers can read `userErrors` themselves. */
async function gql<T>(
  workspaceId: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GqlResult<T>> {
  // ⭐ Every caller expects `{success:false}`, never a throw — `getShopifyCredentials` throws on a
  // disconnected workspace, `fetch` rejects on a network fault, and `res.json()` throws on a
  // non-JSON 200. appstle.ts wraps each export; we convert once, here, so no exported function
  // can surprise the routing layer with an exception.
  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return { errors: [{ message: `Shopify HTTP ${res.status}` }] };
    return (await res.json()) as GqlResult<T>;
  } catch (err) {
    return { errors: [{ message: errText(err) }] };
  }
}

/** Collapse a mutation payload's transport errors + userErrors into our flat result shape. */
function toResult(env: GqlResult<Record<string, { userErrors?: { message: string }[] }>>, field: string): SubscriptionActionResult {
  if (env.errors?.length) return { success: false, error: env.errors.map((e) => e.message).join("; ") };
  const ue = env.data?.[field]?.userErrors ?? [];
  if (ue.length) return { success: false, error: ue.map((e) => e.message).join("; ") };
  return { success: true };
}

/**
 * Run draft-based edits inside one open/commit envelope.
 *
 * `mutate` receives the draftId and should perform every edit that must land atomically. A
 * failure inside it aborts BEFORE commit, so the contract is untouched — the draft is simply
 * abandoned. There is no explicit discard mutation and none is needed.
 */
export async function withDraft(
  workspaceId: string,
  contractId: string,
  mutate: (draftId: string) => Promise<SubscriptionActionResult>,
): Promise<SubscriptionActionResult> {
  const open = await gql<{ subscriptionContractUpdate: { draft?: { id: string }; userErrors: { message: string }[] } }>(
    workspaceId,
    `mutation($id:ID!){ subscriptionContractUpdate(contractId:$id){ draft { id } userErrors { message } } }`,
    { id: contractGid(contractId) },
  );
  const opened = toResult(open as never, "subscriptionContractUpdate");
  if (!opened.success) return opened;
  const draftId = open.data?.subscriptionContractUpdate?.draft?.id;
  if (!draftId) return { success: false, error: "subscriptionContractUpdate returned no draft" };

  const edited = await mutate(draftId);
  if (!edited.success) return edited; // abort before commit — contract untouched

  const commit = await gql<{ subscriptionDraftCommit: { userErrors: { message: string }[] } }>(
    workspaceId,
    `mutation($id:ID!){ subscriptionDraftCommit(draftId:$id){ contract { id } userErrors { message } } }`,
    { id: draftId },
  );
  return toResult(commit as never, "subscriptionDraftCommit");
}

// ── status: pause / cancel / resume ────────────────────────────────────────────────────────

const STATUS_MUTATION = {
  pause: ["subscriptionContractPause", "subscriptionContractId"],
  cancel: ["subscriptionContractCancel", "subscriptionContractId"],
  resume: ["subscriptionContractActivate", "subscriptionContractId"],
} as const;

/** Mirrors `appstleSubscriptionAction`. Direct mutations — no draft. */
export async function shopifySubscriptionAction(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
): Promise<SubscriptionActionResult> {
  const [field, arg] = STATUS_MUTATION[action];
  const env = await gql(
    workspaceId,
    `mutation($id:ID!){ ${field}(${arg}:$id){ contract { id status } userErrors { message } } }`,
    { id: contractGid(contractId) },
  );
  return toResult(env as never, field);
}

// ── the calendar ───────────────────────────────────────────────────────────────────────────

/**
 * Mirrors `appstleUpdateNextBillingDate`. Accepts `YYYY-MM-DD` or a full ISO datetime.
 *
 * ⚠️ Shopify does NOT advance this itself after a successful charge — verified. Whatever moves
 * the calendar forward after a renewal is ours to call.
 */
export async function shopifySetNextBillingDate(
  workspaceId: string,
  contractId: string,
  nextBillingDate: string,
): Promise<SubscriptionActionResult> {
  // ⭐ NOON UTC, matching appstle.ts. Midnight-UTC floored "Oct 2" back to Oct 1 in negative-offset
  // US zones and mis-billed the wrong day (Sofia, ticket 83ee7005). Noon is the SAME calendar day
  // across UTC-10..UTC-4; 10:00Z is exactly midnight at UTC-10, i.e. zero margin on that very edge.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(nextBillingDate)
    ? `${nextBillingDate}T12:00:00Z`
    : nextBillingDate;
  const env = await gql(
    workspaceId,
    `mutation($id:ID!,$d:DateTime!){ subscriptionContractSetNextBillingDate(contractId:$id, date:$d){ contract { id nextBillingDate } userErrors { message } } }`,
    { id: contractGid(contractId), d: iso },
  );
  return toResult(env as never, "subscriptionContractSetNextBillingDate");
}

/** Mirrors `appstleUpdateBillingInterval`. Draft-based — the policy lives on the draft. */
export async function shopifyUpdateBillingInterval(
  workspaceId: string,
  contractId: string,
  interval: "DAY" | "WEEK" | "MONTH" | "YEAR",
  intervalCount: number,
): Promise<SubscriptionActionResult> {
  // ⭐ The TS union is NOT a runtime guarantee — action-executor.ts force-casts a raw
  // LLM-produced string into this position, so a lowercase "month" reaches us. Appstle
  // normalized here after Jim O'Brien (ticket 5e7c1c80, 2026-05-19) was escalated over exactly
  // that. Keep the guard.
  const iv = String(interval).toUpperCase();
  if (!["DAY", "WEEK", "MONTH", "YEAR"].includes(iv)) {
    return { success: false, error: `invalid interval "${interval}" (expected DAY|WEEK|MONTH|YEAR)` };
  }
  if (!Number.isFinite(intervalCount) || intervalCount < 1) {
    return { success: false, error: `invalid intervalCount "${intervalCount}"` };
  }

  // Read the existing policies first: SubscriptionBillingPolicyInput is a WHOLE-OBJECT replace,
  // so sending only {interval,intervalCount} silently wipes anchors / minCycles / maxCycles and
  // moves every future charge date on an anchored contract.
  const existing = await gql<{ subscriptionContract?: {
    billingPolicy?: { minCycles: number | null; maxCycles: number | null; anchors: unknown[] };
    deliveryPolicy?: { anchors: unknown[] };
  } }>(
    workspaceId,
    `query($id:ID!){ subscriptionContract(id:$id){
        billingPolicy { minCycles maxCycles anchors { type day month cutoffDay } }
        deliveryPolicy { anchors { type day month cutoffDay } } } }`,
    { id: contractGid(contractId) },
  );
  if (existing.errors?.length) {
    return { success: false, error: existing.errors.map((e) => e.message).join("; ") };
  }
  const bp = existing.data?.subscriptionContract?.billingPolicy;
  const dp = existing.data?.subscriptionContract?.deliveryPolicy;

  return withDraft(workspaceId, contractId, async (draftId) => {
    const env = await gql(
      workspaceId,
      `mutation($id:ID!,$in:SubscriptionDraftInput!){ subscriptionDraftUpdate(draftId:$id, input:$in){ draft { id } userErrors { message } } }`,
      {
        id: draftId,
        in: {
          billingPolicy: {
            interval: iv,
            intervalCount,
            ...(bp?.minCycles != null ? { minCycles: bp.minCycles } : {}),
            ...(bp?.maxCycles != null ? { maxCycles: bp.maxCycles } : {}),
            ...(bp?.anchors?.length ? { anchors: bp.anchors } : {}),
          },
          deliveryPolicy: {
            interval: iv,
            intervalCount,
            ...(dp?.anchors?.length ? { anchors: dp.anchors } : {}),
          },
        },
      },
    );
    return toResult(env as never, "subscriptionDraftUpdate");
  });
}

// ── skip / unskip ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve a concrete cycle index.
 *
 * ⚠️ Shopify enforces `SubscriptionBillingCycleSelector requires exactly one of index, date` —
 * an empty selector `{}` is REJECTED, so there is no "just do the next one" mode. Indices are
 * 1-based (`index: 0` → "Billing cycle index out of range").
 *
 * `date: now` is NOT a usable default either: it resolves to the CURRENT cycle, which is
 * normally already BILLED. So we read the schedule and pick the first cycle that is actually
 * still actionable.
 */
async function resolveCycleSelector(
  workspaceId: string,
  contractId: string,
  cycleIndex: number | undefined,
  opts: { wantSkipped?: boolean } = {},
): Promise<{ ok: true; index: number } | { ok: false; error: string }> {
  if (cycleIndex != null) return { ok: true, index: cycleIndex };
  const cycles = await getUpcomingBillingCycles(workspaceId, contractId, { first: 25 });
  if (!cycles.success) return { ok: false, error: cycles.error ?? "could not read billing cycles" };
  const match = (cycles.cycles ?? []).find((c) =>
    c.status === "UNBILLED" && (opts.wantSkipped ? c.skipped : !c.skipped));
  if (!match) {
    return { ok: false, error: opts.wantSkipped
      ? "no skipped upcoming billing cycle to unskip"
      : "no unbilled upcoming billing cycle to skip" };
  }
  return { ok: true, index: match.index };
}

/**
 * Mirrors `appstleSkipNextOrder` / `appstleSkipUpcomingOrder`.
 *
 * ⭐ A REAL per-cycle skip, unlike today's implementation which shoves `next_billing_date`
 * forward and so conflates "skip this one" with "change my date".
 *
 * Takes a CONTRACT id, not Appstle's billing-attempt id — Shopify addresses a cycle by
 * (contract, selector). `cycleIndex` omitted means the next unbilled cycle.
 */
export async function shopifySkipBillingCycle(
  workspaceId: string,
  contractId: string,
  cycleIndex?: number,
): Promise<SubscriptionActionResult> {
  const sel = await resolveCycleSelector(workspaceId, contractId, cycleIndex);
  if (!sel.ok) return { success: false, error: sel.error };
  const env = await gql(
    workspaceId,
    `mutation($in:SubscriptionBillingCycleInput!){ subscriptionBillingCycleSkip(billingCycleInput:$in){ billingCycle { skipped } userErrors { message } } }`,
    { in: { contractId: contractGid(contractId), selector: { index: sel.index } } },
  );
  return toResult(env as never, "subscriptionBillingCycleSkip");
}

/** Mirrors `appstleUnskipOrder`, addressed by contract rather than Appstle's attempt id. */
export async function shopifyUnskipBillingCycle(
  workspaceId: string,
  contractId: string,
  cycleIndex?: number,
): Promise<SubscriptionActionResult> {
  const sel = await resolveCycleSelector(workspaceId, contractId, cycleIndex, { wantSkipped: true });
  if (!sel.ok) return { success: false, error: sel.error };
  const env = await gql(
    workspaceId,
    `mutation($in:SubscriptionBillingCycleInput!){ subscriptionBillingCycleUnskip(billingCycleInput:$in){ billingCycle { skipped } userErrors { message } } }`,
    { in: { contractId: contractGid(contractId), selector: { index: sel.index } } },
  );
  return toResult(env as never, "subscriptionBillingCycleUnskip");
}

// ── payment method ─────────────────────────────────────────────────────────────────────────

/** Mirrors `appstleSwitchPaymentMethod`. Draft-based. */
export async function shopifySwitchPaymentMethod(
  workspaceId: string,
  contractId: string,
  paymentMethodId: string,
): Promise<SubscriptionActionResult> {
  const gid = String(paymentMethodId).startsWith("gid://")
    ? String(paymentMethodId)
    : `gid://shopify/CustomerPaymentMethod/${paymentMethodId}`;
  return withDraft(workspaceId, contractId, async (draftId) => {
    const env = await gql(
      workspaceId,
      `mutation($id:ID!,$in:SubscriptionDraftInput!){ subscriptionDraftUpdate(draftId:$id, input:$in){ draft { id } userErrors { message } } }`,
      { id: draftId, in: { paymentMethodId: gid } },
    );
    return toResult(env as never, "subscriptionDraftUpdate");
  });
}

// ── lines ──────────────────────────────────────────────────────────────────────────────────

/**
 * Add a line to the contract.
 *
 * 🚨 **NOT a drop-in for `appstleAddFreeProduct`.** Appstle sends `isOneTimeProduct: "true"`, so
 * its free gift ships ONCE. `subscriptionDraftLineAdd` adds a **RECURRING** contract line. The
 * live caller is the cancel-flow save offer (`portal/handlers/cancel-journey.ts`) — swapping it
 * naively would ship a free product on every renewal, forever, to every customer who took a
 * retention gift. Real recurring COGS, and it would "succeed" silently.
 *
 * A one-time addition on Shopify is a per-cycle contract edit, not a draft line add. Until that
 * is built, do NOT route the retention-gift caller here.
 */
export async function shopifyAddLine(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
  currentPrice: string = "0.00",
): Promise<SubscriptionActionResult> {
  return withDraft(workspaceId, contractId, async (draftId) => {
    const env = await gql(
      workspaceId,
      `mutation($id:ID!,$in:SubscriptionLineInput!){ subscriptionDraftLineAdd(draftId:$id, input:$in){ lineAdded { id } userErrors { message } } }`,
      { id: draftId, in: { productVariantId: variantGid(variantId), quantity, currentPrice } },
    );
    return toResult(env as never, "subscriptionDraftLineAdd");
  });
}

/**
 * Mirrors `appstleSwapProduct`. Direct — `subscriptionContractProductChange` needs no draft.
 *
 * Takes the LINE id, not the old variant id: Shopify addresses the line, and a contract can
 * legitimately carry the same variant on two lines. Resolve the line via
 * `getSubscriptionContract` before calling.
 */
export async function shopifySwapProduct(
  workspaceId: string,
  contractId: string,
  lineId: string,
  newVariantId: string,
): Promise<SubscriptionActionResult> {
  const env = await gql(
    workspaceId,
    `mutation($c:ID!,$l:ID!,$in:SubscriptionContractProductChangeInput!){
       subscriptionContractProductChange(subscriptionContractId:$c, lineId:$l, input:$in){
         lineUpdated { id } userErrors { message } } }`,
    { c: contractGid(contractId), l: lineId, in: { productVariantId: variantGid(newVariantId) } },
  );
  return toResult(env as never, "subscriptionContractProductChange");
}

/**
 * Change a line's quantity.
 *
 * ⭐ Takes an optional `alsoInDraft` so the caller can land the quantity change AND its
 * quantity-break discount in ONE commit. Splitting them leaves a window where the customer is
 * on the new quantity at the old tier — and a charge in that window bills the wrong amount.
 */
export async function shopifyUpdateLineQuantity(
  workspaceId: string,
  contractId: string,
  lineId: string,
  quantity: number,
  alsoInDraft?: (draftId: string) => Promise<SubscriptionActionResult>,
): Promise<SubscriptionActionResult> {
  return withDraft(workspaceId, contractId, async (draftId) => {
    const env = await gql(
      workspaceId,
      `mutation($d:ID!,$l:ID!,$in:SubscriptionLineUpdateInput!){ subscriptionDraftLineUpdate(draftId:$d, lineId:$l, input:$in){ lineUpdated { id quantity } userErrors { message } } }`,
      { d: draftId, l: lineId, in: { quantity } },
    );
    const r = toResult(env as never, "subscriptionDraftLineUpdate");
    if (!r.success || !alsoInDraft) return r;
    return alsoInDraft(draftId);
  });
}

// ── billing ────────────────────────────────────────────────────────────────────────────────

export interface BillingAttemptResult extends SubscriptionActionResult {
  attemptId?: string;
  ready?: boolean;
  orderId?: string;
  orderName?: string;
  errorCode?: string;
  /** Shopify ACCEPTED the attempt. Says nothing about whether the card was charged. */
  accepted?: boolean;
  /** The outcome is settled — `success` is only meaningful once this is true. */
  terminal?: boolean;
  /** Dispatched but unresolved (3DS/CHALLENGED, or our poll timed out). Do NOT bill or retry. */
  pending?: boolean;
}

/**
 * Fire a charge. Mirrors `appstleAttemptBilling` / `orderNowByContract`, but addressed by
 * CONTRACT — Appstle billed an "upcoming order" id, Shopify bills a contract.
 *
 * `idempotencyKey` is a first-class Shopify field: pass the renewal's cycle key
 * (see [[subscription-cycle-charge-claim]]) so a duplicate dispatch cannot double-charge.
 *
 * Returns as soon as the attempt is ACCEPTED (~550ms, `ready: false`). The outcome arrives
 * either by polling `getBillingAttempt` (~8s in practice) or on the
 * `subscription_billing_attempts/*` webhooks. Poll for the common case so the caller's
 * pre-charge guards and dunning branch stay inline; the webhook is the backstop for
 * CHALLENGED (3DS) and for anything outliving the function.
 */
export async function shopifyAttemptBilling(
  workspaceId: string,
  contractId: string,
  idempotencyKey: string,
  opts: {
    inventoryPolicy?: "PRODUCT_VARIANT_INVENTORY_POLICY" | "ALLOW_OVERSELLING";
    /**
     * Which cycle to bill. **Omitting this bills Shopify's CURRENT calendar cycle**, which is
     * anchored to `createdAt + n × billingPolicy` and drifts from our `next_billing_date` — on a
     * live contract we observed our mirror saying 2027-01-15 while Shopify's next unbilled cycle
     * was 2026-11-03, and the "current" cycle was already BILLED. Pass a selector once the
     * renewal worker knows which cycle it is firing.
     */
    billingCycleSelector?: { index: number } | { date: string };
  } = {},
): Promise<BillingAttemptResult> {
  const env = await gql<{ subscriptionBillingAttemptCreate: { subscriptionBillingAttempt?: { id: string; ready: boolean }; userErrors: { message: string }[] } }>(
    workspaceId,
    `mutation($id:ID!,$in:SubscriptionBillingAttemptInput!){
       subscriptionBillingAttemptCreate(subscriptionContractId:$id, subscriptionBillingAttemptInput:$in){
         subscriptionBillingAttempt { id ready } userErrors { message } } }`,
    {
      id: contractGid(contractId),
      in: {
        idempotencyKey,
        ...(opts.inventoryPolicy ? { inventoryPolicy: opts.inventoryPolicy } : {}),
        ...(opts.billingCycleSelector ? { billingCycleSelector: opts.billingCycleSelector } : {}),
      },
    },
  );
  const base = toResult(env as never, "subscriptionBillingAttemptCreate");
  if (!base.success) return base;
  const a = env.data?.subscriptionBillingAttemptCreate?.subscriptionBillingAttempt;
  // `toResult` passes a 200 whose payload never materialized. Without this guard we would
  // return success with attemptId undefined, and the caller would poll `id: undefined`.
  if (!a?.id) return { success: false, error: "billingAttemptCreate returned no attempt" };
  return { success: true, accepted: true, terminal: false, attemptId: a.id, ready: a.ready };
}

/** Read a billing attempt back. `ready`/`completedAt` set means the outcome is final. */
export async function getBillingAttempt(
  workspaceId: string,
  attemptId: string,
): Promise<BillingAttemptResult> {
  const env = await gql<{ subscriptionBillingAttempt?: { id: string; ready: boolean; errorCode?: string; errorMessage?: string; completedAt?: string; order?: { id: string; name: string } } }>(
    workspaceId,
    `query($id:ID!){ subscriptionBillingAttempt(id:$id){ id ready errorCode errorMessage completedAt order { id name } } }`,
    { id: attemptId },
  );
  if (env.errors?.length) return { success: false, error: env.errors.map((e) => e.message).join("; ") };
  const a = env.data?.subscriptionBillingAttempt;
  if (!a) return { success: false, error: "billing attempt not found" };
  const terminal = a.ready || !!a.completedAt || !!a.errorCode;
  return {
    // ⭐ `success` requires a SETTLED, error-free attempt. Previously this was `!a.errorCode`,
    // which reported a still-PENDING attempt (no errorCode yet) as success — a caller doing
    // `if (r.success) markRenewalPaid()` would book a charge that never happened.
    success: terminal && !a.errorCode,
    terminal,
    pending: !terminal,
    attemptId: a.id,
    ready: a.ready || !!a.completedAt,
    orderId: a.order?.id,
    orderName: a.order?.name,
    errorCode: a.errorCode ?? undefined,
    error: a.errorMessage ?? undefined,
  };
}

/**
 * Poll an attempt to a terminal outcome. Bounded — a CHALLENGED (3DS) attempt can sit pending
 * for hours, and blocking on it would hold the renewal step open; that case is the webhook's.
 */
export async function awaitBillingAttempt(
  workspaceId: string,
  attemptId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<BillingAttemptResult & { timedOut?: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const started = Date.now();
  for (;;) {
    const r = await getBillingAttempt(workspaceId, attemptId);
    if (r.terminal) return r;
    if (Date.now() - started > timeoutMs) {
      // ⭐ NEVER report an unsettled charge as success. A CHALLENGED (3DS) attempt sits pending
      // for hours; returning `success:true` here would book an uncollected renewal as paid.
      // `pending:true` is the signal to leave the cycle open and let the webhook settle it.
      return { ...r, success: false, terminal: false, pending: true, timedOut: true };
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────

export interface ContractLine {
  id: string;
  title: string;
  quantity: number;
  /** The VARIANT gid — `SubscriptionLine` also exposes `productId`; they are not interchangeable. */
  variantId: string | null;
  sku: string | null;
  currentPrice: string | null;
  sellingPlanName: string | null;
}

/** The contract as Shopify holds it — the authoritative state, not our mirror. */
export async function getSubscriptionContract(
  workspaceId: string,
  contractId: string,
): Promise<{
  success: boolean;
  error?: string;
  contract?: {
    id: string; status: string; nextBillingDate: string | null;
    interval: string | null; intervalCount: number | null;
    paymentMethodId: string | null; lines: ContractLine[];
  };
}> {
  const env = await gql<{ subscriptionContract?: Record<string, unknown> }>(
    workspaceId,
    `query($id:ID!){ subscriptionContract(id:$id){
        id status nextBillingDate
        billingPolicy { interval intervalCount }
        customerPaymentMethod { id }
        lines(first:50){ pageInfo { hasNextPage } edges { node { id title quantity sellingPlanName sku
          variantId
          currentPrice { amount } } } } } }`,
    { id: contractGid(contractId) },
  );
  if (env.errors?.length) return { success: false, error: env.errors.map((e) => e.message).join("; ") };
  const k = env.data?.subscriptionContract as never as {
    id: string; status: string; nextBillingDate: string | null;
    billingPolicy?: { interval: string; intervalCount: number };
    customerPaymentMethod?: { id: string };
    lines: { edges: { node: { id: string; title: string; quantity: number; sellingPlanName: string | null; variantId: string | null; sku: string | null; currentPrice?: { amount: string } } }[] };
  } | undefined;
  if (!k) return { success: false, error: "contract not found (or not owned by this app)" };
  return {
    success: true,
    contract: {
      id: k.id,
      status: k.status,
      nextBillingDate: k.nextBillingDate,
      interval: k.billingPolicy?.interval ?? null,
      intervalCount: k.billingPolicy?.intervalCount ?? null,
      paymentMethodId: k.customerPaymentMethod?.id ?? null,
      lines: (k.lines?.edges ?? []).map((e) => ({
        id: e.node.id,
        title: e.node.title,
        quantity: e.node.quantity,
        variantId: e.node.variantId,
        sku: e.node.sku,
        currentPrice: e.node.currentPrice?.amount ?? null,
        sellingPlanName: e.node.sellingPlanName,
      })),
    },
  };
}

/**
 * Upcoming billing cycles. Mirrors `appstleGetUpcomingOrders`.
 *
 * Reading the schedule from Shopify rather than deriving it from our `next_billing_date` hands
 * the anchors / skips / per-cycle-edit maths to Shopify — a genuine offload, even though the
 * decision to FIRE stays ours.
 */
export async function getUpcomingBillingCycles(
  workspaceId: string,
  contractId: string,
  opts: { startDate?: string; endDate?: string; first?: number } = {},
): Promise<{ success: boolean; error?: string; cycles?: { index: number; expectedDate: string; skipped: boolean; status: string }[] }> {
  const start = opts.startDate ?? new Date().toISOString();
  const end = opts.endDate ?? new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const env = await gql<{ subscriptionBillingCycles?: { edges: { node: { cycleIndex: number; billingAttemptExpectedDate: string; skipped: boolean; status: string } }[] } }>(
    workspaceId,
    `query($id:ID!,$s:DateTime!,$e:DateTime!,$n:Int!){
       subscriptionBillingCycles(contractId:$id, first:$n,
         billingCyclesDateRangeSelector:{ startDate:$s, endDate:$e }){
         edges { node { cycleIndex billingAttemptExpectedDate skipped status } } } }`,
    { id: contractGid(contractId), s: start, e: end, n: opts.first ?? 10 },
  );
  if (env.errors?.length) return { success: false, error: env.errors.map((e) => e.message).join("; ") };
  return {
    success: true,
    cycles: (env.data?.subscriptionBillingCycles?.edges ?? []).map((e) => ({
      index: e.node.cycleIndex,
      expectedDate: e.node.billingAttemptExpectedDate,
      skipped: e.node.skipped,
      status: e.node.status,
    })),
  };
}

/** Surface a thrown error the same way every caller here reports a failed one. */
export function asFailure(e: unknown): SubscriptionActionResult {
  return { success: false, error: errText(e) };
}
