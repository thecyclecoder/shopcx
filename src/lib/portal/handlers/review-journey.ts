// Review-journey portal handler — Phase 3 of docs/brain/specs/review-collection-foundations.md.
//
// Product-specific review collection: product image, 5-star, per-product slider
// questions (attribute_scores), a seeded comment. Submitting persists a
// product_reviews row (with attribute_scores), mints a customer-scoped Shopify
// discount via the shared createCustomerDiscount() chokepoint, and routes a
// 1-3 star rating to CS as a ticket instead of publishing — the moderation
// rule. Reward is minted REGARDLESS of rating (contingent-on-good-rating is
// paying for positive reviews).
//
// Session state lives in journey_sessions: the tokenized link points at
// `journey_sessions.id`, its `product_id` is the SKU being reviewed
// (Phase 1's new column), and `config_snapshot` freezes the per-product
// question set for the life of the session so editing the journey definition
// can't corrupt an in-flight one.

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createCustomerDiscount } from "@/lib/coupons";

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

export const reviewJourney: RouteHandler = async ({ auth, route, req, url }) => {
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const admin = createAdminClient();

  // The session token identifies both the customer AND the product being
  // reviewed (via journey_sessions.product_id — new in Phase 1). Callers
  // pass ?token=… to GET the form and POST the answers.
  const token = url.searchParams.get("token") || "";
  if (!token) return jsonErr({ error: "missing_token" }, 400);

  const { data: session } = await admin
    .from("journey_sessions")
    .select("id, workspace_id, customer_id, product_id, status, token_expires_at, responses, config_snapshot")
    .eq("token", token)
    .maybeSingle();
  if (!session) return jsonErr({ error: "session_not_found" }, 404);
  if (session.workspace_id !== auth.workspaceId) return jsonErr({ error: "session_workspace_mismatch" }, 403);
  if (session.token_expires_at && new Date(session.token_expires_at) < new Date()) {
    return jsonErr({ error: "session_expired" }, 410);
  }
  if (!session.product_id) {
    return jsonErr({ error: "session_missing_product" }, 400);
  }
  if (session.status === "completed") {
    return jsonErr({ error: "session_already_completed" }, 409);
  }

  const { data: product } = await admin
    .from("products")
    .select("id, title, image_url, product_type, reviewable")
    .eq("id", session.product_id)
    .maybeSingle();
  if (!product) return jsonErr({ error: "product_not_found" }, 404);
  if (product.reviewable === false) {
    // Belt-and-suspenders: the sender filters on reviewable=true, but a race
    // (session created just before an add-on was flipped) should still refuse.
    return jsonErr({ error: "product_not_reviewable" }, 409);
  }

  // Build the question set: drop Flavor for the accessory products; the rest
  // are the same across the catalog. If the session's config_snapshot already
  // has a frozen set (recorded when the session was materialized), use that
  // instead so an in-flight session sees a stable form.
  const frozen = session.config_snapshot as { questions?: typeof DEFAULT_QUESTIONS } | null;
  const questions =
    frozen?.questions && Array.isArray(frozen.questions) && frozen.questions.length > 0
      ? frozen.questions
      : DEFAULT_QUESTIONS.filter((q) => q.key !== "flavor" || isFlavorRelevant(product));

  if (req.method === "GET") {
    return jsonOk({
      ok: true,
      route,
      session_id: session.id,
      product: {
        id: product.id,
        title: product.title,
        image_url: product.image_url,
      },
      questions,
      min_comment_length: MIN_COMMENT_LENGTH,
    });
  }

  // POST: submit.
  const body = (await req.clone().json().catch(() => null)) as {
    rating?: number;
    attribute_scores?: AttributeScores;
    comment?: string;
  } | null;

  const rating = Number(body?.rating ?? 0);
  const attribute_scores: AttributeScores = (body?.attribute_scores || {}) as AttributeScores;
  const comment = String(body?.comment || "").trim();

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return jsonErr({ error: "invalid_rating" }, 400);
  }
  if (comment.length < MIN_COMMENT_LENGTH) {
    return jsonErr({ error: "comment_too_short", min: MIN_COMMENT_LENGTH }, 400);
  }

  // Atomic session claim — Fix 1 of docs/brain/specs/review-collection-foundations.md.
  // Two concurrent POSTs with the same valid token could both pass the earlier
  // `session.status === 'completed'` check and race, producing duplicate
  // product_reviews rows AND multiple reward coupons from a single ask. Guard
  // by claiming the session first: workspace-scoped compare-and-set from
  // ['pending','in_progress'] → 'processing', selecting id back. Zero rows
  // returned means a concurrent request already claimed it (or the row was
  // completed / expired since the earlier read) — bail with 409 BEFORE any
  // side effect fires. Mirrors the shape at
  // src/app/api/journey/[token]/submit-payment/route.ts:141.
  const { data: claimed } = await admin
    .from("journey_sessions")
    .update({ status: "processing" })
    .eq("id", session.id)
    .eq("workspace_id", auth.workspaceId)
    .in("status", ["pending", "in_progress"])
    .select("id");
  if (!claimed || claimed.length !== 1) {
    return jsonErr({ error: "session_already_completed_or_processing" }, 409);
  }

  // Route 1-3 stars to CS as a ticket instead of publishing. The moderation
  // rule: a low-star review is a support signal, not display material. The
  // reward is ALWAYS minted (see below) — a low rating does not eat the
  // customer's incentive.
  const status: "published" | "pending" = rating >= 4 ? "published" : "pending";

  // Persist the review row, including the slider answers as attribute_scores.
  const { data: reviewInsert, error: reviewErr } = await admin
    .from("product_reviews")
    .insert({
      workspace_id: auth.workspaceId,
      customer_id: session.customer_id,
      product_id: session.product_id,
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
    return jsonErr({ error: "review_insert_failed" }, 500);
  }

  // Low-star → open a CS ticket carrying the review body + attribute_scores so
  // the moderator has full context. `review_requests.ticket_id` (Phase 1) is
  // stamped by the SEND side of the ladder, not here — this handler owns only
  // the customer-facing submit.
  let ticketId: string | null = null;
  if (rating <= 3) {
    const { data: ticket, error: ticketErr } = await admin
      .from("tickets")
      .insert({
        workspace_id: auth.workspaceId,
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

  // Mint the reward via the shared chokepoint — createCustomerDiscount handles
  // the linked-account fan-out + internal fallback for customers with no
  // shopify_customer_id (spec § Phase 2 fallback).
  const reward = await createCustomerDiscount(auth.workspaceId, session.customer_id, {
    amount: 5,
    codePrefix: "REVIEW",
    expiryDays: 90,
    title: `Review reward — ${product.title || product.id}`,
  });

  // Mark the session completed even if the reward mint failed (we don't want
  // to lose the review), but surface a null code so the frontend knows to
  // fall back to a "we'll email your reward" message. Compare-and-set on the
  // 'processing' marker planted at the claim above so a caller who never held
  // the claim (should be impossible after the earlier CAS but defense-in-
  // depth) cannot flip the row to 'completed'.
  await admin
    .from("journey_sessions")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
      outcome: rating >= 4 ? "review_published" : "review_routed_to_cs",
      responses: {
        rating,
        attribute_scores,
        comment,
      },
    })
    .eq("id", session.id)
    .eq("workspace_id", auth.workspaceId)
    .eq("status", "processing");

  return jsonOk({
    ok: true,
    route,
    review_id: reviewInsert.id,
    published: status === "published",
    ticket_id: ticketId,
    reward_code: reward?.code || null,
    reward_source: reward?.source || null,
  });
};
