/**
 * Customer-voice mining reader — Phase 1 of growth-customer-voice-to-ad-angles.
 *
 * Pulls structured fragments of captured customer voice for a workspace+product, returned typed
 * with a `signal` label so a later Phase 2 synthesizer (the Opus pass against the active pattern
 * matrix) can score them into [[../tables/product_ad_angles]] candidates without re-reading raw DB.
 *
 * Three sources, three signals:
 *   - positive review excerpts → signal='positive'  (rating ≥ 4, body present)
 *   - cancel-flow reasons        → signal='objection' (free-text reason captured during cancel-journey)
 *   - support-ticket subjects   → signal='use_case'  (workspace-wide; downstream LLM clusters product)
 *
 * NO LLM call. Pure structured extraction — every fragment carries its source table + row id so
 * Phase 2 can write `metadata.mined_from` arrays back to `product_ad_angles`.
 *
 * Schema reality (the spec mentions a `subscription_events` table that does not exist on main): the
 * canonical cancel-flow reason write today is `customer_events` rows with
 *   event_type='portal.subscription.cancel_reason'
 *   summary='Cancel reason selected: {label}'
 *   properties.reason: <reason slug>
 * — written by `src/lib/portal/handlers/cancel-journey.ts`. We read that.
 *
 * Similarly the spec mentions `tickets.summary` — there is no such column on `tickets`. The
 * AI-generated summary lives on `ticket_analyses.summary`, one-or-more rows per ticket. We read both
 * `tickets.subject` (always present) and join the latest `ticket_analyses.summary` per ticket when
 * available, preferring the richer summary as the fragment text.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type VoiceSignal = "positive" | "objection" | "use_case";
export type VoiceSource = "product_reviews" | "customer_events" | "tickets";

export interface VoiceFragment {
  source: VoiceSource;
  source_id: string;
  text: string;
  signal: VoiceSignal;
}

export interface MineCustomerVoiceOpts {
  workspaceId: string;
  productId: string;
  /** Window of recency for every source. Default 90 days — matches the spec. */
  sinceMs?: number;
}

export interface MineCustomerVoiceResult {
  fragments: VoiceFragment[];
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const CANCEL_REASON_EVENT_TYPE = "portal.subscription.cancel_reason";

interface ReviewRow {
  id: string;
  body: string | null;
  smart_quote: string | null;
  rating: number | null;
}

interface CancelEventRow {
  id: string;
  summary: string | null;
  properties: { reason?: string | null; reasonLabel?: string | null } | null;
}

interface TicketRow {
  id: string;
  subject: string | null;
}

interface TicketAnalysisRow {
  ticket_id: string;
  summary: string | null;
  created_at: string | null;
}

/** Trim + normalize whitespace; drop fragments whose text would be empty after that. */
function clean(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Mine customer voice into typed fragments for a workspace+product.
 *
 * `productId` is the strong product binding for `product_reviews` (which carries a real
 * `product_id` FK). For `customer_events` and `tickets` the schema has no product FK today, so
 * those sources are workspace-scoped only — the downstream Phase 2 synthesizer is responsible for
 * relevance scoring against the named product.
 */
export async function mineCustomerVoice(
  admin: Admin,
  opts: MineCustomerVoiceOpts,
): Promise<MineCustomerVoiceResult> {
  const { workspaceId, productId } = opts;
  const sinceMs = opts.sinceMs ?? NINETY_DAYS_MS;
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();

  const fragments: VoiceFragment[] = [];

  // ── 1. Positive review excerpts ──────────────────────────────────────────────────────────────
  // `product_reviews` is product-scoped via `product_id`. Per [[../tables/product_reviews]] the
  // "Tier-4 PROOF" qualifier is `rating>=4`; we additionally require a non-empty body so the
  // fragment has actual customer language.
  const { data: reviewData } = await admin
    .from("product_reviews")
    .select("id, body, smart_quote, rating")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .gte("rating", 4)
    .gte("created_at", sinceIso)
    .not("body", "is", null);
  for (const r of (reviewData || []) as ReviewRow[]) {
    // Prefer `smart_quote` (Klaviyo-extracted highlight, max ~15 words) when present — it's the
    // most useful piece for an ad — and fall back to the full body.
    const text = clean(r.smart_quote) || clean(r.body);
    if (!text) continue;
    fragments.push({ source: "product_reviews", source_id: r.id, text, signal: "positive" });
  }

  // ── 2. Cancel-flow reasons (objections) ─────────────────────────────────────────────────────
  // The cancel-journey writes a `customer_events` row per reason-step, event_type='portal.subscription.cancel_reason'.
  // The reason label is the human-readable string we want — preferred in `properties.reasonLabel`
  // when present, else the slug in `properties.reason`, else parse from the row's `summary`
  // ("Cancel reason selected: {label}"). The fragment text is whichever is most readable.
  const { data: cancelData } = await admin
    .from("customer_events")
    .select("id, summary, properties")
    .eq("workspace_id", workspaceId)
    .eq("event_type", CANCEL_REASON_EVENT_TYPE)
    .gte("created_at", sinceIso);
  for (const e of (cancelData || []) as CancelEventRow[]) {
    const props = e.properties || {};
    const label = clean(props.reasonLabel) || clean(props.reason);
    const fromSummary = clean(e.summary).replace(/^cancel reason selected:\s*/i, "");
    const text = label || fromSummary;
    if (!text) continue;
    fragments.push({ source: "customer_events", source_id: e.id, text, signal: "objection" });
  }

  // ── 3. Support-ticket themes (use-cases) ────────────────────────────────────────────────────
  // No product FK on `tickets` — workspace-scoped only. We pull each ticket's subject AND, when an
  // analysis exists, the latest `ticket_analyses.summary` (higher-signal). Each ticket produces ONE
  // fragment; summary wins over subject when both exist. Phase 2 LLM clusters the result down to
  // the workspace's named product.
  const { data: ticketData } = await admin
    .from("tickets")
    .select("id, subject")
    .eq("workspace_id", workspaceId)
    .is("merged_into", null)
    .gte("created_at", sinceIso)
    .not("subject", "is", null);
  const ticketRows = (ticketData || []) as TicketRow[];
  if (ticketRows.length > 0) {
    const ticketIds = ticketRows.map((t) => t.id);
    const { data: analysisData } = await admin
      .from("ticket_analyses")
      .select("ticket_id, summary, created_at")
      .in("ticket_id", ticketIds)
      .not("summary", "is", null);
    // Pick the most recent analysis per ticket as the canonical summary.
    const latestSummary = new Map<string, string>();
    for (const a of (analysisData || []) as TicketAnalysisRow[]) {
      const text = clean(a.summary);
      if (!text) continue;
      const prev = latestSummary.get(a.ticket_id);
      if (!prev) latestSummary.set(a.ticket_id, text);
    }
    for (const t of ticketRows) {
      const text = latestSummary.get(t.id) || clean(t.subject);
      if (!text) continue;
      fragments.push({ source: "tickets", source_id: t.id, text, signal: "use_case" });
    }
  }

  return { fragments };
}
