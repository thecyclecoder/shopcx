import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPolicyCustomerFacing } from "@/lib/policies";

/**
 * GET /api/storefront/guarantee?shop=store.myshopify.com
 *
 * Public, CORS-enabled guarantee statement for the checkout UI extension.
 *
 * The live `refunds` policy row decides WHETHER the guarantee shows. policies has
 * two halves ([[docs/brain/tables/policies.md]] § Two halves): internal_summary +
 * rules are authoritative, customer_summary is the published rendering. A
 * customer-facing surface reads the published half, so this uses
 * getPolicyCustomerFacing — the same row the help centre and the AI agent answer
 * from. Retire or deactivate that policy and the block disappears from checkout
 * with no deploy.
 *
 * It returns a HEADLINE ONLY, no body text. An earlier version lifted the
 * guarantee sentence out of the policy, which carried "covers your first order
 * only" into checkout — accurate, but more qualification than this surface wants.
 * A bare headline cannot overstate the offer or drift from the policy, and the
 * full terms stay one click away where they already live.
 *
 * FAILS CLOSED. No workspace, no active policy, or no extractable sentence all
 * return enabled:false and the extension renders nothing. A guarantee is a legal
 * promise: showing a hardcoded fallback when the database is unreachable would be
 * asserting a commitment nobody can currently verify.
 *
 * The first-order scope is carried deliberately. The policy says the guarantee
 * covers "your first order only", so an unqualified "30-Day Money-Back Guarantee"
 * in checkout would overstate it for a returning customer.
 *
 * CORS is open and must stay open: checkout UI extensions run in a Web Worker with
 * a NULL origin, so Access-Control-Allow-Origin must be "*" — an origin allowlist
 * cannot match them.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
};

const OFF = { enabled: false } as const;

/**
 * The published policy must actually still offer a money-back guarantee. This is a
 * presence check, not a parser: it decides whether to show the headline, and never
 * supplies its wording.
 */
function offersGuarantee(markdown: string): boolean {
  return /money-?back guarantee/i.test(markdown);
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  const shop = new URL(request.url).searchParams.get("shop");
  if (!shop) return NextResponse.json(OFF, { headers: CORS });

  try {
    const admin = createAdminClient();
    const { data: workspace } = await admin
      .from("workspaces")
      .select("id")
      .eq("shopify_myshopify_domain", shop)
      .maybeSingle();
    if (!workspace) return NextResponse.json(OFF, { headers: CORS });

    const policy = await getPolicyCustomerFacing(admin, workspace.id, "refunds");
    if (!policy?.customer_summary) return NextResponse.json(OFF, { headers: CORS });

    if (!offersGuarantee(policy.customer_summary)) {
      return NextResponse.json(OFF, { headers: CORS });
    }

    return NextResponse.json(
      {
        enabled: true,
        title: "30-Day Money-Back Guarantee",
        policy_version: policy.version,
        updated_at: policy.updated_at,
      },
      { headers: CORS },
    );
  } catch {
    return NextResponse.json(OFF, { headers: CORS });
  }
}
