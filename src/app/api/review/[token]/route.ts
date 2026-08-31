/**
 * PUBLIC review-journey endpoint — the tokenized magic link.
 *
 * No login. The token IS the credential, exactly like the CSAT flow already in
 * production (`src/app/api/csat/[ticketId]/route.ts`) — and strictly stronger:
 * CSAT's token is a deterministic HMAC of the ticket id, this one is 96 stored
 * random bits with an expiry and a single-use claim.
 *
 * Why it exists: the journey first shipped as a PORTAL handler, but
 * `PortalAuthResult.loggedInCustomerId` is non-optional — every portal handler
 * is authenticated by construction. A security pass then bound the token to the
 * logged-in customer, which was right for that context and wrong for the
 * product: it turned a no-login magic link into a login wall in front of a
 * message that is already asking the customer for a favour. The spec asked for
 * "tokenized magic link, no login" AND "portal handler" in the same phase;
 * those are incompatible. This is the public half.
 *
 * Authority comes from the SESSION ROW, never the request — workspace,
 * customer, and product are all read from `journey_sessions`. Holding a link
 * lets you review one product as one customer, once, before it expires.
 *
 *   GET  /api/review/{token} → { product, questions, min_comment_length }
 *   POST /api/review/{token} { rating, attribute_scores, comment }
 */
import { NextResponse } from "next/server";
import {
  loadReviewSessionByToken,
  submitReviewForSession,
  type AttributeScores,
} from "@/lib/review-journey-core";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const load = await loadReviewSessionByToken(token);
  if (!load.ok) return NextResponse.json({ error: load.error }, { status: load.status });

  return NextResponse.json({
    ok: true,
    product: {
      id: load.product.id,
      title: load.product.title,
      image_url: load.product.image_url,
    },
    questions: load.questions,
    min_comment_length: 15,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const load = await loadReviewSessionByToken(token);
  if (!load.ok) return NextResponse.json({ error: load.error }, { status: load.status });

  const body = (await request.json().catch(() => null)) as {
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
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, ...(result.min ? { min: result.min } : {}) },
      { status: result.status },
    );
  }
  return NextResponse.json(result);
}
