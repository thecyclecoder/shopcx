/**
 * Stall detection + `superseded`-status reconciliation for the
 * `public.replacements` table.
 *
 * The SC132221 rot pattern: Evan H.'s Jun-23 replacement sat at
 * `status='address_confirmed'` with `replacement_order_id = null` for
 * 17 days because the Shopify draft-order call silently failed (the
 * "UN" countryCode bug — Phase 1). The row surfaced nowhere; Sol only
 * discovered it on 2026-07-10 while investigating the customer's other
 * ticket. Two problems:
 *
 *   1. A stalled row must SURFACE (Improve/alert) past a threshold —
 *      not silently rot at address_confirmed forever.
 *   2. When a LATER replacement for the same original_order fulfills
 *      the items (SC134462 + SC134463 shipped the two owed tabs), the
 *      stale record needs a first-class terminal status
 *      (`superseded`) — not a red `failed` (the customer outcome was
 *      correct) and not a lingering `address_confirmed`.
 *
 * This library is the pure + read-only + narrow-write surface for
 * both. Callers (a cron, an ops script, or CS on the fly) use it.
 * All mutations are compare-and-set-guarded — a supersede write can
 * only fire when the row is still `address_confirmed` in the same
 * workspace, so a raced or already-terminal row can't be overwritten.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Default: a replacement stuck at address_confirmed for 7+ days is
 * stalled. Evan's SC132221 record sat 17. 7 days is well past any
 * normal retry window (address confirm → Shopify draft usually
 * completes in seconds — hours at the extreme when a customer takes
 * time to reply). */
export const DEFAULT_STALL_THRESHOLD_DAYS = 7;

/** Shape of a `replacements` row that this library reasons about.
 * Kept minimal — only the fields we actually need — so callers can
 * pass a projection from either a Supabase select or a test fixture. */
export interface ReplacementRow {
  id: string;
  workspace_id: string;
  status: string;
  original_order_id: string | null;
  replacement_order_id: string | null;
  shopify_replacement_order_name: string | null;
  items: unknown;
  created_at: string;
}

/**
 * Pure predicate — is this replacement stalled?
 *
 * A row is stalled when:
 *   • status === 'address_confirmed', AND
 *   • replacement_order_id is null AND shopify_replacement_order_name
 *     is null (the Shopify draft-order call never completed), AND
 *   • it was created more than `thresholdDays` ago.
 *
 * Grounded on the SC132221 rot pattern — `address_confirmed` with no
 * Shopify order name after 17 days.
 */
export function isReplacementStalled(
  row: ReplacementRow,
  now: Date,
  thresholdDays: number = DEFAULT_STALL_THRESHOLD_DAYS,
): boolean {
  if (row.status !== "address_confirmed") return false;
  if (row.replacement_order_id) return false;
  if (row.shopify_replacement_order_name) return false;
  const createdMs = Date.parse(row.created_at);
  if (!Number.isFinite(createdMs)) return false;
  const ageMs = now.getTime() - createdMs;
  const thresholdMs = thresholdDays * 24 * 60 * 60 * 1000;
  return ageMs >= thresholdMs;
}

/**
 * Pure predicate — does this later replacement fully supersede the
 * stalled one?
 *
 * A stalled row `stalled` is superseded by a later row `later` when:
 *   • same workspace + same original_order_id (both non-null), AND
 *   • later.created_at is strictly after stalled.created_at, AND
 *   • later.status is a shipped/created/completed terminal (a
 *     `failed`/`denied`/`pending` sibling can't supersede — the
 *     customer got no goods from those states), AND
 *   • later.shopify_replacement_order_name is present (real Shopify
 *     order exists) OR later.replacement_order_id is present, AND
 *   • the item VARIANT SET of `later` covers the item VARIANT SET
 *     of `stalled` (every variant in the stalled cart shipped in the
 *     later order — SC134462 + SC134463 shipped the two owed tabs).
 *
 * The "covers" check matches SC132221's shape: Evan was owed Peach
 * Mango + Strawberry Lemonade; two later single-item orders together
 * covered both variants, so from the customer's perspective the Jun-23
 * record's obligation was fulfilled. We accept an array of later
 * candidates so the caller can pass multiple siblings for the same
 * `original_order_id` and we check UNION coverage.
 */
export function isSupersededBy(
  stalled: ReplacementRow,
  later: ReplacementRow[],
): boolean {
  if (!stalled.original_order_id) return false;
  const stalledVariants = extractVariantIds(stalled.items);
  if (stalledVariants.size === 0) return false;

  const relevant = later.filter(l =>
    l.workspace_id === stalled.workspace_id &&
    l.original_order_id === stalled.original_order_id &&
    l.id !== stalled.id &&
    Date.parse(l.created_at) > Date.parse(stalled.created_at) &&
    isTerminalShippedStatus(l.status) &&
    (l.shopify_replacement_order_name || l.replacement_order_id)
  );
  if (relevant.length === 0) return false;

  const coveredVariants = new Set<string>();
  for (const l of relevant) {
    for (const v of extractVariantIds(l.items)) coveredVariants.add(v);
  }
  for (const v of stalledVariants) {
    if (!coveredVariants.has(v)) return false;
  }
  return true;
}

function isTerminalShippedStatus(status: string): boolean {
  return status === "created" || status === "shipped" || status === "completed";
}

function extractVariantIds(items: unknown): Set<string> {
  const set = new Set<string>();
  if (!Array.isArray(items)) return set;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    const v = String(it.variantId || it.variant_id || "").trim();
    if (v) set.add(v);
  }
  return set;
}

/**
 * Read-only DB query — return every replacement in a workspace that is
 * currently stalled per [[isReplacementStalled]]. Callers surface these
 * (Improve card, alert, ops dashboard) so the SC132221 17-day rot
 * cannot recur silently.
 */
export async function listStalledReplacements(
  admin: Admin,
  workspaceId: string,
  opts: { now?: Date; thresholdDays?: number } = {},
): Promise<ReplacementRow[]> {
  const now = opts.now ?? new Date();
  const thresholdDays = opts.thresholdDays ?? DEFAULT_STALL_THRESHOLD_DAYS;
  const olderThan = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("replacements")
    .select("id, workspace_id, status, original_order_id, replacement_order_id, shopify_replacement_order_name, items, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "address_confirmed")
    .is("replacement_order_id", null)
    .is("shopify_replacement_order_name", null)
    .lt("created_at", olderThan);
  if (error || !data) return [];
  // In-code re-filter is a belt-and-suspenders check — the DB predicates
  // above already match the pure predicate but a schema drift (e.g. a
  // future column-renamed migration) would surface as a failing test
  // here instead of shipping silent wrong rows to the caller.
  return (data as ReplacementRow[]).filter(r => isReplacementStalled(r, now, thresholdDays));
}

/**
 * Compare-and-set writer — flip a stalled row to `superseded`. Guarded
 * by workspace_id + id + status='address_confirmed' so a raced or
 * already-terminal row cannot be overwritten (coaching #9/#10 — the
 * guard predicate at the mutation site, not just at the read site).
 * Returns `true` iff exactly one row transitioned.
 */
export async function applySupersede(
  admin: Admin,
  args: { workspaceId: string; replacementId: string; supersededByReplacementId: string | null },
): Promise<boolean> {
  const detail = args.supersededByReplacementId
    ? `Superseded by replacement ${args.supersededByReplacementId}`
    : "Superseded (later replacement for same original order fulfilled the items)";
  const { data, error } = await admin
    .from("replacements")
    .update({ status: "superseded", reason_detail: detail })
    .eq("workspace_id", args.workspaceId)
    .eq("id", args.replacementId)
    .eq("status", "address_confirmed")
    .select("id");
  if (error || !data) return false;
  return data.length === 1;
}
