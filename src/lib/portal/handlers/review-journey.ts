// Review-journey PORTAL handler — the authenticated surface.
//
// The portal is authenticated by construction: `PortalAuthResult.loggedInCustomerId`
// is a non-optional string, so every handler here has a logged-in customer. This
// surface therefore keeps the extra binding from Fix 2 — the session's customer
// must be in the authenticated customer's linked-account group, so a logged-in
// customer can never act as a different customer whose token they obtained.
//
// The PUBLIC magic link (src/app/api/review/[token]/route.ts) has no login and
// relies on the token alone, which is the design the spec asked for. Both
// surfaces call the SAME core (src/lib/review-journey-core.ts) so the review
// write, the low-star routing, the reward mint, and the single-use claim can
// never diverge between them.

import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, checkPortalBan, findCustomer } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  loadReviewSessionByToken,
  submitReviewForSession,
  MIN_COMMENT_LENGTH,
  type AttributeScores,
} from "@/lib/review-journey-core";

/**
 * Expand a customer id to its full customer_links group. Inline copy of
 * `expandLinkedCustomerIds` (src/lib/loyalty.ts:99, not exported).
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

export const reviewJourney: RouteHandler = async ({ auth, route, req, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const authedCustomer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!authedCustomer) return jsonErr({ error: "customer_not_found" }, 404);

  const linkedCustomerIds = await linkedCustomerIdsFor(auth.workspaceId, authedCustomer.id);

  const token = url.searchParams.get("token") || "";
  const load = await loadReviewSessionByToken(token, {
    expectCustomerIn: new Set(linkedCustomerIds),
    expectWorkspaceId: auth.workspaceId,
  });
  if (!load.ok) return jsonErr({ error: load.error }, load.status);

  if (req.method === "GET") {
    return jsonOk({
      ok: true,
      route,
      session_id: load.session.id,
      product: {
        id: load.product.id,
        title: load.product.title,
        image_url: load.product.image_url,
      },
      questions: load.questions,
      min_comment_length: MIN_COMMENT_LENGTH,
    });
  }

  const body = (await req.clone().json().catch(() => null)) as {
    rating?: number;
    attribute_scores?: AttributeScores;
    comment?: string;
  } | null;

  const result = await submitReviewForSession({
    session: load.session,
    product: load.product,
    rating: Number(body?.rating ?? 0),
    attribute_scores: (body?.attribute_scores || {}) as AttributeScores,
    comment: String(body?.comment || ""),
    claimCustomerIn: linkedCustomerIds,
  });
  if (!result.ok) {
    return jsonErr({ error: result.error, ...(result.min ? { min: result.min } : {}) }, result.status);
  }
  const { ok: _ok, ...rest } = result;
  return jsonOk({ ok: true, route, ...rest });
};
