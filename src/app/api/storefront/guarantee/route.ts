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
 * `terms` carries the published RETURNS policy as plain-text sections for the
 * checkout block's "See terms" modal (the guarantee's conditions live there):
 * the policy's own words, structured, never paraphrased.
 *
 * The headline itself is a HEADLINE ONLY, no body text. An earlier version lifted the
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

type TermsBlock = { type: "paragraph" | "item"; text: string };
type TermsSection = { heading: string; blocks: TermsBlock[] };

/** Markdown inline → plain text: `**bold**` and `[label](href)` keep only their words. */
const plain = (line: string) =>
  line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_`]/g, "")
    .trim();

/**
 * The published Returns policy as sections for the checkout terms modal: each
 * `## heading` opens a section, `- item` lines are list items, other lines are
 * paragraphs, and the `# title` is dropped (the modal has its own heading).
 * Checkout extensions can't render markdown, so this hands them plain text in the
 * policy's own words — no wording is added here.
 */
function termsSections(markdown: string): TermsSection[] {
  const sections: TermsSection[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line || /^#\s/.test(line)) continue;
    const h = line.match(/^#{2,}\s+(.*)$/);
    if (h) {
      sections.push({ heading: plain(h[1]), blocks: [] });
      continue;
    }
    if (!sections.length) sections.push({ heading: "", blocks: [] });
    const item = line.match(/^[-*]\s+(.*)$/);
    sections[sections.length - 1].blocks.push(
      item ? { type: "item", text: plain(item[1]) } : { type: "paragraph", text: plain(line) },
    );
  }
  return sections.filter((sec) => sec.blocks.length);
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

    // The guarantee's terms live in the published Returns policy. Optional: if it
    // is missing the headline still shows, the block just offers no "See terms".
    const returns = await getPolicyCustomerFacing(admin, workspace.id, "returns");
    const terms = returns?.customer_summary ? termsSections(returns.customer_summary) : [];

    return NextResponse.json(
      {
        enabled: true,
        title: "30-Day Money-Back Guarantee",
        policy_version: policy.version,
        updated_at: policy.updated_at,
        terms,
      },
      { headers: CORS },
    );
  } catch {
    return NextResponse.json(OFF, { headers: CORS });
  }
}
