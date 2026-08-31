/**
 * Review-journey CORE — the token-authorized logic behind the public magic
 * link, shared with the (authenticated) portal handler so the two surfaces
 * cannot diverge.
 *
 * **The token IS the credential.** `journey_sessions.token` is 96 random bits
 * (`mintReviewRequestToken`), stored not derived, carries an expiry, and is
 * single-use via the compare-and-set claim below. Every authority — workspace,
 * customer, product — is read from the SESSION ROW, never from the request. So
 * holding a link lets you review exactly one product as exactly one customer,
 * once, before it expires. That is what a magic link is supposed to grant.
 *
 * Same posture as the CSAT flow already in production
 * (`src/app/api/csat/[ticketId]/route.ts`), and strictly stronger: CSAT's token
 * is a deterministic HMAC of the ticket id, ours is stored random bytes with an
 * expiry and a single-use claim.
 *
 * Why this exists: the journey originally shipped as a PORTAL handler, and the
 * portal's `PortalAuthResult.loggedInCustomerId` is non-optional — every portal
 * handler is authenticated by construction. A security pass then (correctly,
 * for that context) bound the token to the logged-in customer, which turned a
 * no-login magic link into a login-walled form and would have gutted response
 * rates on a message that is already asking for a favour. The spec said
 * "tokenized magic link, no login" and "portal handler" in the same phase; they
 * are incompatible. This module is the public half.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { createCustomerDiscount } from "@/lib/coupons";

/**
 * Expand a customer id to its full customer_links group. Inline copy of
 * `expandLinkedCustomerIds` (src/lib/loyalty.ts:99, not exported) — used here
 * to bind the tokenized review session to the AUTHENTICATED portal customer,
 * so a logged-in customer in the same workspace can NEVER submit a review /
 * open a CS ticket / mint a reward AS a different customer whose token they
 * somehow obtained. Fix 2 of docs/brain/specs/review-collection-foundations.md.
 */
async function linkedCustomerIdsFor(workspaceId: string, customerId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: peers } = await admin
    .from("customer_links")
    .select("customer_id")
    .eq("workspace_id", workspaceId)
    .eq("group_id", link.group_id);
  const ids = new Set<string>([customerId]);
  for (const p of peers || []) if (p.customer_id) ids.add(p.customer_id);
  return [...ids];
}

// Default per-product question set — sourced from the retired Klaviyo flow.
// The set is per-product-configurable via `journey_definitions.config`; this
// is the FALLBACK when a product has no override. Flavor is deliberately
// filtered by product type below (meaningless for the Tumbler / Mixer / Mug).
const DEFAULT_QUESTIONS: Array<{
  key: string;
  label: string;
  low: string;
  high: string;
  type: "slider" | "choice";
  choices?: string[];
}> = [
  { key: "convenience", label: "Convenience", low: "Not Convenient", high: "Very Convenient", type: "slider" },
  { key: "effectiveness", label: "Effectiveness", low: "Not Effective", high: "Very Effective", type: "slider" },
  { key: "flavor", label: "Flavor", low: "I Don't Like It", high: "I Love It", type: "slider" },
  {
    key: "expectation",
    label: "Overall Expectation",
    low: "Did Not Meet",
    high: "Exceeded Expectations",
    type: "choice",
    choices: ["Did Not Meet", "What I Expected", "Exceeded Expectations"],
  },
];

// Products where the Flavor slider is meaningless. Matched by product_type or
// title substring rather than a hard SKU list so a rename doesn't reintroduce
// the wrong question.
const NON_FLAVOR_TITLE_PATTERNS = [/tumbler/i, /mixer/i, /mug/i];

function isFlavorRelevant(product: {
  title?: string | null;
  product_type?: string | null;
}): boolean {
  const t = (product.title || "").toLowerCase();
  const pt = (product.product_type || "").toLowerCase();
  if (pt === "accessory" || pt === "merch") return false;
  for (const pat of NON_FLAVOR_TITLE_PATTERNS) if (pat.test(t)) return false;
  return true;
}

interface AttributeScores {
  convenience?: number; // 1-5
  effectiveness?: number;
  flavor?: number;
  expectation?: "Did Not Meet" | "What I Expected" | "Exceeded Expectations";
  [key: string]: unknown;
}

/**
 * Build the seeded comment prompt from the customer's slider answers. High
 * effectiveness + high flavor → "you love the taste — what would you tell
 * someone who's on the fence?". A less rosy combo → a matched prompt. Emits
 * a fallback if attribute_scores is empty.
 */
export function buildSeededPrompt(scores: AttributeScores, productTitle: string): string {
  const eff = Number(scores.effectiveness ?? 0);
  const flav = Number(scores.flavor ?? 0);
  const conv = Number(scores.convenience ?? 0);
  const exp = String(scores.expectation ?? "");
  if (eff >= 4 && flav >= 4) {
    return `You said ${productTitle} works well and you love the taste — what would you tell someone who's on the fence?`;
  }
  if (eff >= 4 && conv >= 4) {
    return `You said ${productTitle} works well and is easy to use — what would you tell a friend trying it for the first time?`;
  }
  if (exp === "Exceeded Expectations") {
    return `You said ${productTitle} exceeded your expectations — what surprised you most?`;
  }
  if (exp === "Did Not Meet" || eff <= 2) {
    return `What didn't work about ${productTitle}? Anything specific we could improve?`;
  }
  return `Tell someone else what your experience with ${productTitle} was like.`;
}

// Comment floor — matches the widget-facing filter at
// src/app/api/storefront/[workspace]/product-reviews/route.ts (`body is not
// null` + non-trivial). A star-only review does not render anywhere.
const MIN_COMMENT_LENGTH = 15;


export type ReviewSessionLoad =
  | { ok: true; session: LoadedReviewSession; product: LoadedReviewProduct; questions: typeof DEFAULT_QUESTIONS }
  | { ok: false; error: string; status: number };

export interface LoadedReviewSession {
  id: string;
  workspace_id: string;
  customer_id: string;
  product_id: string;
  status: string | null;
  config_snapshot: unknown;
  variant_id: string | null;
}

export interface LoadedReviewProduct {
  id: string;
  title: string | null;
  image_url: string | null;
  product_type: string | null;
  /** Legacy Klaviyo-era join key on product_reviews — still NOT NULL there. */
  shopify_product_id: string | null;
  /** Variant name shown in the header when the session names a variant. */
  variant_title?: string | null;
}

/**
 * Resolve a review token to its session + product + question set, applying every
 * gate that does not require a side effect. Callers get a typed refusal with the
 * HTTP status to return.
 *
 * `expectCustomerIn` is the portal's extra binding — when supplied, the session's
 * customer must be in that set. The public magic link passes nothing, because
 * the token itself is the authority.
 */
export async function loadReviewSessionByToken(
  token: string,
  opts?: { expectCustomerIn?: Set<string>; expectWorkspaceId?: string },
): Promise<ReviewSessionLoad> {
  if (!token) return { ok: false, error: "missing_token", status: 400 };
  const admin = createAdminClient();

  let q = admin
    .from("journey_sessions")
    .select("id, workspace_id, customer_id, product_id, variant_id, status, token_expires_at, responses, config_snapshot")
    .eq("token", token);
  if (opts?.expectWorkspaceId) q = q.eq("workspace_id", opts.expectWorkspaceId);
  const { data: session } = await q.maybeSingle();

  if (!session) return { ok: false, error: "session_not_found", status: 404 };
  if (opts?.expectCustomerIn && !opts.expectCustomerIn.has(session.customer_id)) {
    return { ok: false, error: "session_customer_mismatch", status: 403 };
  }
  if (session.token_expires_at && new Date(session.token_expires_at as string) < new Date()) {
    return { ok: false, error: "session_expired", status: 410 };
  }
  if (!session.product_id) return { ok: false, error: "session_missing_product", status: 400 };
  if (session.status === "completed") return { ok: false, error: "session_already_completed", status: 409 };

  const { data: product } = await admin
    .from("products")
    .select("id, title, image_url, product_type, reviewable, shopify_product_id")
    .eq("id", session.product_id)
    .eq("workspace_id", session.workspace_id)
    .maybeSingle();
  if (!product) return { ok: false, error: "product_not_found", status: 404 };
  if (product.reviewable === false) {
    return { ok: false, error: "product_not_reviewable", status: 409 };
  }

  // Imagery: variant review_hero → product review_hero → products.image_url.
  //
  // products.image_url is the PDP hero — a packshot. It sells "what am I
  // buying"; this page needs "remember why you love this", which is the
  // prepared product looking craveable. And it has to be per-VARIANT, because
  // flavours are different colours: Black Cherry is a deep red glass, Pina
  // Colada a creamy tropical one, so one product-level shot is wrong for at
  // least one of them by construction. When the session names the variant the
  // customer actually bought, they see THEIR flavour.
  let heroUrl: string | null = product.image_url;
  let variantTitle: string | null = null;
  {
    if (session.variant_id) {
      const { data: vm } = await admin
        .from("product_media")
        .select("url")
        .eq("variant_id", session.variant_id)
        .eq("slot", "review_hero")
        .limit(1)
        .maybeSingle();
      if (vm?.url) heroUrl = vm.url as string;
      const { data: v } = await admin
        .from("product_variants")
        .select("title")
        .eq("id", session.variant_id)
        .maybeSingle();
      variantTitle = (v?.title as string) ?? null;
    }
    if (heroUrl === product.image_url) {
      // No variant asset (or no variant on the session) — try the
      // product-scoped review_hero before falling back to the packshot.
      const { data: pm } = await admin
        .from("product_media")
        .select("url")
        .eq("product_id", session.product_id)
        .is("variant_id", null)
        .eq("slot", "review_hero")
        .limit(1)
        .maybeSingle();
      if (pm?.url) heroUrl = pm.url as string;
    }
  }
  (product as LoadedReviewProduct).image_url = heroUrl;
  (product as LoadedReviewProduct).variant_title = variantTitle;

  const frozen = session.config_snapshot as { questions?: typeof DEFAULT_QUESTIONS } | null;
  const questions =
    frozen?.questions && Array.isArray(frozen.questions) && frozen.questions.length > 0
      ? frozen.questions
      : DEFAULT_QUESTIONS.filter((q2) => q2.key !== "flavor" || isFlavorRelevant(product));

  return {
    ok: true,
    session: session as unknown as LoadedReviewSession,
    product: product as unknown as LoadedReviewProduct,
    questions,
  };
}

export interface SubmitReviewInput {
  session: LoadedReviewSession;
  product: LoadedReviewProduct;
  rating: number;
  attribute_scores: AttributeScores;
  comment: string;
  /** Portal only — pins the claim to the authenticated linked-account group. */
  claimCustomerIn?: string[];
}

export type SubmitReviewResult =
  | { ok: true; review_id: string; published: boolean; ticket_id: string | null; reward_code: string | null; reward_source: string | null }
  | { ok: false; error: string; status: number; min?: number };

/**
 * Persist the review, route a low star to CS, mint the reward, close the session.
 * Every write derives its workspace/customer/product from the SESSION, never
 * from caller input.
 */
export async function submitReviewForSession(input: SubmitReviewInput): Promise<SubmitReviewResult> {
  const { session, product } = input;
  const admin = createAdminClient();

  const rating = Number(input.rating);
  const comment = String(input.comment || "").trim();
  const attribute_scores = (input.attribute_scores || {}) as AttributeScores;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "invalid_rating", status: 400 };
  }
  if (comment.length < MIN_COMMENT_LENGTH) {
    return { ok: false, error: "comment_too_short", status: 400, min: MIN_COMMENT_LENGTH };
  }

  // Single-use claim BEFORE any side effect — two concurrent POSTs on one token
  // would otherwise both pass the status read and mint two rewards.
  let claim = admin
    .from("journey_sessions")
    .update({ status: "processing" })
    .eq("id", session.id)
    .eq("workspace_id", session.workspace_id);
  if (input.claimCustomerIn?.length) claim = claim.in("customer_id", input.claimCustomerIn);
  const { data: claimed, error: claimError } = await claim
    .in("status", ["pending", "in_progress"])
    .select("id");

  // Distinguish "someone else claimed it" from "the write itself failed".
  // These are the same zero-rows shape, and conflating them hid a total
  // outage: 'processing' was missing from journey_sessions_status_check, so
  // EVERY claim was rejected by the constraint, returned no rows, and was
  // reported to the customer as a benign 409 "already completed". Nobody
  // could submit a review at all, and the error that said so was discarded
  // one line above. A DB error here is a 500 that gets logged, never a 409.
  if (claimError) {
    console.error("[review-journey] session claim failed:", claimError.message);
    return { ok: false, error: "session_claim_failed", status: 500 };
  }
  if (!claimed || claimed.length !== 1) {
    return { ok: false, error: "session_already_completed_or_processing", status: 409 };
  }

  // EVERY review is held for a human. Nothing self-publishes to the storefront.
  //
  // This previously auto-published anything rated 4+ and only held 1-3 stars.
  // That is the wrong default for a page whose reviews land on live PDPs, in
  // the ad tool's proof anchors, and in Google rich snippets: a 5-star rating
  // says nothing about whether the BODY is publishable — it can name a
  // competitor, contain a medical claim we cannot make, describe the wrong
  // product, or carry personal information. The first real submission proved
  // the point: a sincere 5-star review of Superfood Tabs ("the stickpacks are
  // so convenient") auto-published against Creatine Prime+, because that is
  // the product the session named.
  //
  // A team member publishes from /dashboard/reviews, which already buckets
  // pending / published / rejected / featured and whose moderation actions are
  // local-only since the Klaviyo sunset.
  const status: "pending" = "pending";

  const { data: reviewInsert, error: reviewErr } = await admin
    .from("product_reviews")
    .insert({
      workspace_id: session.workspace_id,
      customer_id: session.customer_id,
      product_id: session.product_id,
      // `product_reviews.shopify_product_id` is a Klaviyo-era join key that
      // predates `product_id` and is still NOT NULL. Omitting it made EVERY
      // submit fail with a not-null violation → review_insert_failed → a 500
      // the page rendered as "something went wrong". The companion migration
      // relaxes the constraint (Shopify is sunsetting; an internal-only
      // product would hit this again), but we populate it regardless so the
      // legacy column stays consistent for anything still reading it.
      shopify_product_id: product.shopify_product_id ?? "internal",
      rating,
      body: comment,
      attribute_scores,
      verified_purchase: true,
      status,
      review_type: "review",
    })
    .select("id")
    .single();
  if (reviewErr || !reviewInsert) {
    console.error("[review-journey] product_reviews insert failed:", reviewErr?.message);
    return { ok: false, error: "review_insert_failed", status: 500 };
  }

  let ticketId: string | null = null;
  if (rating <= 3) {
    const { data: ticket, error: ticketErr } = await admin
      .from("tickets")
      .insert({
        workspace_id: session.workspace_id,
        customer_id: session.customer_id,
        subject: `Low-star review: ${product.title || product.id}`,
        status: "open",
        channel: "portal",
        tags: ["review:low_star"],
      })
      .select("id")
      .single();
    if (ticketErr) console.error("[review-journey] ticket insert failed:", ticketErr.message);
    ticketId = ticket?.id || null;
    if (ticketId) {
      await admin.from("ticket_messages").insert({
        ticket_id: ticketId,
        direction: "inbound",
        visibility: "internal",
        author_type: "customer",
        body: `Rating: ${rating} / 5\nProduct: ${product.title}\n\n${comment}\n\nAttribute scores: ${JSON.stringify(attribute_scores)}`,
      });
    }
  }

  // Reward is minted REGARDLESS of rating — contingent-on-a-good-rating is
  // paying for positive reviews.
  const reward = await createCustomerDiscount(session.workspace_id, session.customer_id, {
    amount: 5,
    codePrefix: "REVIEW",
    expiryDays: 90,
    title: `Review reward — ${product.title || product.id}`,
  });

  await admin
    .from("journey_sessions")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      outcome: rating <= 3 ? "review_routed_to_cs" : "review_pending_moderation",
      responses: { rating, attribute_scores, comment },
    })
    .eq("id", session.id)
    .eq("workspace_id", session.workspace_id)
    .eq("status", "processing");

  // Close the ladder's ledger. review_requests is what the nudge cron reads to
  // decide whether to chase a non-responder; leaving it on 'sent' after a
  // completed submit means the customer gets "just floating this back up"
  // three days after they already reviewed. Scoped by (customer, product) and
  // only advances rows still open, so a re-run cannot rewrite history.
  {
    const { error: ledgerErr } = await admin
      .from("review_requests")
      .update({ outcome: rating <= 3 ? "routed_to_cs" : "submitted" })
      .eq("workspace_id", session.workspace_id)
      .eq("customer_id", session.customer_id)
      .eq("product_id", session.product_id)
      .in("outcome", ["sent", "clicked"]);
    if (ledgerErr) {
      // The review is written and the reward is minted — a stale ledger row is
      // a nudge-suppression problem, not a reason to fail the customer.
      console.error("[review-journey] review_requests outcome update failed:", ledgerErr.message);
    }
  }

  return {
    ok: true,
    review_id: reviewInsert.id as string,
    published: false, // always held — a human decides
    ticket_id: ticketId,
    reward_code: reward?.code || null,
    reward_source: reward?.source || null,
  };
}

export { DEFAULT_QUESTIONS, MIN_COMMENT_LENGTH };
export type { AttributeScores };
