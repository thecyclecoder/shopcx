/**
 * PUBLIC "don't ask me again" endpoint for review requests.
 *
 * The token IS the credential, exactly as it is for the review page itself — the
 * customer is identified from the SESSION ROW, never from the request. Holding a
 * link lets you silence review asks for the customer that link belongs to, and
 * nothing else.
 *
 * Deliberately NARROWER than an email unsubscribe: this suppresses review asks
 * only and leaves marketing email untouched. Someone declining to write a review
 * has not asked to stop hearing from the brand, and taking more than they asked
 * for is its own kind of failure.
 *
 * GET (not POST) so it works as a plain link in an email client, and returns a
 * small human page rather than JSON — this URL is clicked by people.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

function page(title: string, detail: string, ok: boolean) {
  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<div style="font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:34rem;margin:14vh auto;padding:0 1.5rem;color:#1a1a1a">
  <h1 style="font-size:1.4rem;margin:0 0 .6rem">${title}</h1>
  <p style="color:#555;margin:0">${detail}</p>
</div>`,
    { status: ok ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return page("Link not recognised", "This link is missing its code.", false);

  const admin = createAdminClient();
  const { data: session } = await admin
    .from("journey_sessions")
    .select("customer_id, workspace_id")
    .eq("token", token)
    .maybeSingle();

  // Same shape as the review page: an unknown token tells you nothing.
  if (!session?.customer_id) {
    return page("Link not recognised", "This link has expired or was already used.", false);
  }

  const { error } = await admin
    .from("customers")
    .update({ review_asks_opted_out_at: new Date().toISOString() })
    .eq("id", session.customer_id as string)
    .eq("workspace_id", session.workspace_id as string)
    .is("review_asks_opted_out_at", null); // idempotent — keep the FIRST opt-out time
  if (error) {
    return page("Something went wrong", "We could not save that just now. Please try again.", false);
  }

  return page(
    "Done — we won't ask again",
    "You're off review requests. This doesn't affect your order updates or emails from us.",
    true,
  );
}
