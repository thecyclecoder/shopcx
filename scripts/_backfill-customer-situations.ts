/**
 * Ship-time seed of `public.product_customer_situations` from the Tabs situations fixture
 * (docs/brain/specs/ai-shopping-agent-mcp.md Phase 1). Seeds the 17 real customer life-situations
 * mined from the best-reviews set (60 verbatim quotes), the shared source for the AI shopping-agent
 * MCP server and the PDP AEO work.
 *
 * Source fixture: fixtures/ai-shopping-agent/superfood-tabs-situations.json — each situation carries
 * product_id (internal UUID), the structure/function framing, review_ids, and per-quote compliance
 * flags. Incentivized/coupon and disease-term quotes are seeded with compliance_ok=false so they are
 * STORED but never surfaced; the SDK (src/lib/customer-situations.ts) strips them on every
 * shopper-facing read.
 *
 * Idempotent — upserts through the SDK on (workspace_id, product_id, slug), so re-running is a
 * no-op. The product_id is resolved from the file and VERIFIED to exist in the workspace before any
 * write; the workspace_id is read from the product row (internal UUID join, never shopify ids).
 *
 * Tracked ship-time backfill (CLAUDE.md § Ship-time backfill-must-be-tracked): the `_backfill-*.ts`
 * name auto-ledgers a pending data_op_runs row on the post-merge hook; the box executor drains it.
 *
 * Dry-run by default; pass --apply to write.
 * Run: npx tsx scripts/_backfill-customer-situations.ts [--apply]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { createAdminClient } from "./_bootstrap";
import { upsertSituations, type SituationQuote, type UpsertSituationInput } from "../src/lib/customer-situations";

const APPLY = process.argv.includes("--apply");
const FIXTURE = join(__dirname, "..", "fixtures", "ai-shopping-agent", "superfood-tabs-situations.json");
const SOURCE = "seed:aeo-2026-11-23";

interface FixtureQuote {
  review_id: string;
  reviewer: string;
  rating: number;
  verified_purchase: boolean;
  featured: boolean;
  verbatim_phrase: string;
  compliance_ok: boolean;
  compliance_note?: string;
}
interface FixtureSituation {
  product_id: string;
  slug: string;
  situation: string;
  who?: string;
  goal?: string;
  noticed?: string;
  timeframe?: string;
  verbatim_phrase?: string;
  review_ids?: string[];
  quotes?: FixtureQuote[];
  compliance_ok?: boolean;
  compliance_note?: string;
}

function toQuotes(quotes: FixtureQuote[] | undefined): SituationQuote[] {
  return (quotes ?? []).map((q) => ({
    review_id: q.review_id,
    reviewer: q.reviewer,
    rating: q.rating,
    verified_purchase: q.verified_purchase,
    featured: q.featured,
    verbatim_phrase: q.verbatim_phrase,
    compliance_ok: q.compliance_ok === true,
    compliance_note: q.compliance_note ?? "",
  }));
}

async function main() {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as { situations: FixtureSituation[] };
  const situations = raw.situations ?? [];
  console.log(`Loaded ${situations.length} situations from ${FIXTURE}`);

  const admin = createAdminClient();

  // Resolve each situation's product → its workspace, verifying the product exists. Group by workspace.
  const productIds = [...new Set(situations.map((s) => s.product_id))];
  const { data: products, error: pErr } = await admin
    .from("products")
    .select("id, workspace_id")
    .in("id", productIds);
  if (pErr) throw new Error(`resolve products: ${pErr.message}`);
  const workspaceByProduct = new Map<string, string>();
  for (const p of products ?? []) workspaceByProduct.set(p.id as string, p.workspace_id as string);

  const missing = productIds.filter((id) => !workspaceByProduct.has(id));
  if (missing.length) {
    throw new Error(`product_id(s) not found in products table: ${missing.join(", ")} — aborting seed.`);
  }

  // Bucket rows by workspace (the SDK upserts per-workspace).
  const byWorkspace = new Map<string, UpsertSituationInput[]>();
  for (const s of situations) {
    const ws = workspaceByProduct.get(s.product_id)!;
    const row: UpsertSituationInput = {
      product_id: s.product_id,
      slug: s.slug,
      situation: s.situation,
      who: s.who ?? null,
      goal: s.goal ?? null,
      noticed: s.noticed ?? null,
      timeframe: s.timeframe ?? null,
      verbatim_phrase: s.verbatim_phrase ?? null,
      review_ids: s.review_ids ?? [],
      quotes: toQuotes(s.quotes),
      compliance_ok: s.compliance_ok === true,
      compliance_note: s.compliance_note ?? null,
      source: SOURCE,
      active: true,
    };
    const bucket = byWorkspace.get(ws) ?? [];
    bucket.push(row);
    byWorkspace.set(ws, bucket);
  }

  const totalQuotes = situations.reduce((n, s) => n + (s.quotes?.length ?? 0), 0);
  const compliantSituations = situations.filter((s) => s.compliance_ok === true).length;
  console.log(
    `Workspaces: ${byWorkspace.size} · situations: ${situations.length} (${compliantSituations} compliant) · quotes: ${totalQuotes}`,
  );

  if (!APPLY) {
    console.log("\nDRY RUN — no writes. Re-run with --apply to seed.");
    for (const [ws, rows] of byWorkspace) {
      console.log(`  workspace ${ws}: would upsert ${rows.length} situation(s)`);
      for (const r of rows) console.log(`    - ${r.slug} (compliance_ok=${r.compliance_ok}, quotes=${r.quotes?.length ?? 0})`);
    }
    return;
  }

  let written = 0;
  for (const [ws, rows] of byWorkspace) {
    const result = await upsertSituations(admin, ws, rows);
    written += result.length;
    console.log(`  workspace ${ws}: upserted ${result.length} situation(s)`);
  }
  console.log(`\n✓ Seeded ${written} situation(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
