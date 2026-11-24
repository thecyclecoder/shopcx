/**
 * Customer-situations SDK — the single read/write chokepoint for `public.product_customer_situations`
 * (docs/brain/libraries/customer-situations.md · docs/brain/tables/product_customer_situations.md).
 *
 * `product_customer_situations` is the verifiable, compliance-checked dataset of the real life
 * situations our customers were in, mined from the best-reviews set. ONE source shared by the AI
 * shopping-agent MCP server (`find_products_for_situation`) and the PDP AI-answers (AEO) work — both
 * read these rows so a situation can't drift between surfaces.
 *
 * COMPLIANCE INVARIANT (north star): incentivized/coupon reviews and pounds-lost / disease-term
 * quotes are STORED (for audit) but MUST NEVER be surfaced to shoppers. Every reader that renders
 * text to a shopper calls through this SDK with the default `compliantOnly=true`, which (1) returns
 * only rows with `compliance_ok=true` AND `active=true` and (2) strips every nested quote whose own
 * `compliance_ok` is not true. A hand-rolled `.from('product_customer_situations')` query bypasses
 * that filter and could leak a non-compliant quote — so it is forbidden outside this file and
 * enforced by scripts/_check-customer-situations-sdk-compliance.ts (wired into predeploy), mirroring
 * the competitors / policies chokepoints.
 *
 * Joins are on the internal product UUID — never shopify_*_id.
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** One mined quote under a situation. Non-compliant quotes are kept for audit, never surfaced. */
export interface SituationQuote {
  review_id: string;
  reviewer: string;
  rating: number;
  verified_purchase: boolean;
  featured: boolean;
  verbatim_phrase: string;
  compliance_ok: boolean;
  compliance_note?: string;
}

/** A row of `public.product_customer_situations`. */
export interface CustomerSituationRow {
  id: string;
  workspace_id: string;
  product_id: string;
  slug: string;
  situation: string;
  who: string | null;
  goal: string | null;
  noticed: string | null;
  timeframe: string | null;
  verbatim_phrase: string | null;
  review_ids: string[];
  quotes: SituationQuote[];
  compliance_ok: boolean;
  compliance_note: string | null;
  source: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Options for {@link listSituations}. */
export interface ListSituationsOptions {
  /** Restrict to one product (internal UUID). */
  productId?: string | null;
  /**
   * Compliance gate. Default TRUE — return only surfaceable rows (compliance_ok + active) with their
   * non-compliant quotes stripped. Pass false ONLY for audit/admin tooling that must see everything.
   */
  compliantOnly?: boolean;
  /** Row cap. Default 200. */
  limit?: number;
}

/** Strip every quote that is not individually compliant — the surface-side quote filter. */
function compliantQuotesOnly(quotes: SituationQuote[]): SituationQuote[] {
  return (quotes ?? []).filter((q) => q?.compliance_ok === true);
}

/** Coerce a raw DB row into {@link CustomerSituationRow} (quotes defaults to []). */
function coerceRow(r: Record<string, unknown>): CustomerSituationRow {
  return {
    ...(r as unknown as CustomerSituationRow),
    review_ids: (r.review_ids as string[] | null) ?? [],
    quotes: ((r.quotes as SituationQuote[] | null) ?? []) as SituationQuote[],
  };
}

/**
 * List situations for a workspace (optionally one product). Default `compliantOnly=true` returns
 * only surfaceable rows with non-compliant quotes stripped — the safe path for every shopper-facing
 * reader. Featured/most-recent first.
 */
export async function listSituations(
  admin: Admin,
  workspaceId: string,
  opts: ListSituationsOptions = {},
): Promise<CustomerSituationRow[]> {
  const compliantOnly = opts.compliantOnly !== false;
  let q = admin
    .from("product_customer_situations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.productId) q = q.eq("product_id", opts.productId);
  if (compliantOnly) q = q.eq("compliance_ok", true).eq("active", true);
  const { data, error } = await q;
  if (error) throw new Error(`listSituations: ${error.message}`);
  const rows = (data ?? []).map((r) => coerceRow(r as Record<string, unknown>));
  if (!compliantOnly) return rows;
  // Surface path: strip every non-compliant nested quote before the text can leave the server.
  return rows.map((row) => ({ ...row, quotes: compliantQuotesOnly(row.quotes) }));
}

/** Options for {@link getSituation}. */
export interface GetSituationOptions {
  /** Default TRUE — returns null for a non-compliant/inactive row, strips non-compliant quotes. */
  compliantOnly?: boolean;
}

/** Fetch one situation by (workspace, product, slug). Compliance gate matches {@link listSituations}. */
export async function getSituation(
  admin: Admin,
  workspaceId: string,
  productId: string,
  slug: string,
  opts: GetSituationOptions = {},
): Promise<CustomerSituationRow | null> {
  const compliantOnly = opts.compliantOnly !== false;
  const { data, error } = await admin
    .from("product_customer_situations")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(`getSituation: ${error.message}`);
  if (!data) return null;
  const row = coerceRow(data as Record<string, unknown>);
  if (!compliantOnly) return row;
  if (!row.compliance_ok || !row.active) return null;
  return { ...row, quotes: compliantQuotesOnly(row.quotes) };
}

/** Input to {@link upsertSituations}. `(workspace_id, product_id, slug)` is the conflict key. */
export interface UpsertSituationInput {
  product_id: string;
  slug: string;
  situation: string;
  who?: string | null;
  goal?: string | null;
  noticed?: string | null;
  timeframe?: string | null;
  verbatim_phrase?: string | null;
  review_ids?: string[];
  quotes?: SituationQuote[];
  compliance_ok?: boolean;
  compliance_note?: string | null;
  source?: string | null;
  active?: boolean;
}

/**
 * Insert-or-update situations for a workspace on `(workspace_id, product_id, slug)`. The sanctioned
 * write path (seed backfill + any future author). Returns the upserted rows (unfiltered — this is a
 * writer, not a shopper-facing read).
 */
export async function upsertSituations(
  admin: Admin,
  workspaceId: string,
  rows: UpsertSituationInput[],
): Promise<CustomerSituationRow[]> {
  if (rows.length === 0) return [];
  const now = new Date().toISOString();
  const payload = rows.map((r) => ({
    workspace_id: workspaceId,
    product_id: r.product_id,
    slug: r.slug,
    situation: r.situation,
    who: r.who ?? null,
    goal: r.goal ?? null,
    noticed: r.noticed ?? null,
    timeframe: r.timeframe ?? null,
    verbatim_phrase: r.verbatim_phrase ?? null,
    review_ids: r.review_ids ?? [],
    quotes: (r.quotes ?? []) as unknown as SituationQuote[],
    compliance_ok: r.compliance_ok ?? false,
    compliance_note: r.compliance_note ?? null,
    source: r.source ?? null,
    active: r.active ?? true,
    updated_at: now,
  }));
  const { data, error } = await admin
    .from("product_customer_situations")
    .upsert(payload, { onConflict: "workspace_id,product_id,slug" })
    .select("*");
  if (error) throw new Error(`upsertSituations: ${error.message}`);
  return (data ?? []).map((r) => coerceRow(r as Record<string, unknown>));
}
