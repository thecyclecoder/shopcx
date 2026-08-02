/**
 * kb-crisis-article-swap — retire the Mixed Berry out-of-stock article and publish the Strawberry
 * Lemonade one in its place (CEO 2026-07-30).
 *
 * The Mixed Berry article is now actively WRONG: it says Mixed Berry is out of stock and that
 * subscribers were swapped to Strawberry Lemonade — the exact inverse of today's reality. It is
 * published on the public help centre AND feeds the AI agent via RAG
 * ([[../docs/brain/lifecycles/help-center]] — `kb_chunks` embeddings are retrieved by
 * `get_product_knowledge`), so leaving it up means both customers and Sol read a stale story.
 *
 * RETIRE, DON'T DELETE. The article is unpublished + deactivated, not dropped: the slug has been
 * indexed and linked, and the record is the only trace of what customers were told during the
 * crisis. Its `kb_chunks` ARE deleted, because an embedding is a live retrieval surface — an
 * unpublished article whose chunks survive keeps feeding the orchestrator wrong facts.
 *
 *   npx tsx scripts/kb-crisis-article-swap.ts            # dry run
 *   npx tsx scripts/kb-crisis-article-swap.ts --apply
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const OLD_SLUG = "mixed-berry-out-of-stock";
const NEW_SLUG = "strawberry-lemonade-out-of-stock";
const PRODUCT_ID = "221d272d-a6c5-4a5d-86ff-ac693926c992"; // Superfood Tabs
const APPLY = process.argv.includes("--apply");

const TITLE = "Strawberry Lemonade Superfood Tabs — Temporarily Out of Stock";
const EXCERPT =
  "Strawberry Lemonade Superfood Tabs are temporarily out of stock. Expected back by November 2026. " +
  "Existing subscribers have been auto-swapped to Mixed Berry, which is back in stock.";

const CONTENT_HTML = `
<p>Our Strawberry Lemonade Superfood Tabs are temporarily out of stock. We expect them back by <strong>November 2026</strong>.</p>
<h3>What we've done for existing subscribers</h3>
<ul>
<li>Your subscription has been automatically switched to <strong>Mixed Berry</strong> — which is back in stock — so your orders keep shipping on schedule</li>
<li>Your price is unchanged</li>
<li>When Strawberry Lemonade returns, we'll switch you back automatically. You don't need to do anything or contact us</li>
</ul>
<h3>Your options</h3>
<ul>
<li><strong>Keep Mixed Berry</strong> — no action needed, your next order ships as scheduled</li>
<li><strong>Choose a different flavor</strong> (Peach Mango is also available) using the link in your email</li>
<li><strong>Pause your subscription</strong> until Strawberry Lemonade is back — we'll restart it automatically when it's available</li>
</ul>
<h3>Is Mixed Berry back?</h3>
<p>Yes. Mixed Berry is in stock and shipping normally. If you were switched off Mixed Berry during its earlier outage, you've already been switched back.</p>
`.trim();

async function main() {
  const admin = createAdminClient() as any;
  console.log(APPLY ? "🔥 APPLYING" : "🔍 DRY RUN");

  const { data: oldArt } = await admin.from("knowledge_base")
    .select("id, slug, title, published, active, view_count").eq("workspace_id", W).eq("slug", OLD_SLUG).maybeSingle();
  console.log(`\nold article: ${oldArt ? `${oldArt.slug} published=${oldArt.published} active=${oldArt.active} views=${oldArt.view_count}` : "(not found)"}`);

  const { data: slCrisis } = await admin.from("crisis_events")
    .select("id, name, status, expected_restock_date").eq("workspace_id", W).ilike("name", "%Strawberry Lemonade%").maybeSingle();
  console.log(`SL crisis: ${slCrisis ? `${slCrisis.id} [${slCrisis.status}] restock ${slCrisis.expected_restock_date}` : "(not found — create it first)"}`);

  const { data: existingNew } = await admin.from("knowledge_base")
    .select("id, published").eq("workspace_id", W).eq("slug", NEW_SLUG).maybeSingle();
  console.log(`new article: ${existingNew ? `already exists (${existingNew.id})` : "will be created"}`);

  if (!APPLY) {
    console.log(`\nWould:\n  1. unpublish + deactivate "${OLD_SLUG}" (kept for the record, its kb_chunks deleted)`);
    console.log(`  2. ${existingNew ? "update" : "create"} "${NEW_SLUG}" — published, linked to the SL crisis`);
    console.log(`\n--- new article ---\n${TITLE}\n\n${EXCERPT}`);
    return;
  }

  // 1. Retire the old one.
  if (oldArt) {
    const { error } = await admin.from("knowledge_base")
      .update({ published: false, active: false, updated_at: new Date().toISOString() })
      .eq("id", oldArt.id);
    if (error) throw error;
    // Embeddings are a LIVE retrieval surface — unpublishing without dropping chunks leaves the
    // orchestrator answering from the stale article.
    const { error: cErr, count } = await admin.from("kb_chunks").delete({ count: "exact" }).eq("kb_id", oldArt.id);
    if (cErr) throw cErr;
    console.log(`  ✓ retired "${OLD_SLUG}" (unpublished + deactivated) · ${count ?? 0} embedding chunk(s) removed`);
  }

  // 2. Publish the new one.
  const payload = {
    workspace_id: W, slug: NEW_SLUG, title: TITLE, excerpt: EXCERPT,
    content: CONTENT_HTML.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    content_html: CONTENT_HTML, category: "product", source: "manual",
    product_id: PRODUCT_ID, crisis_id: slCrisis?.id ?? null,
    published: true, active: true, updated_at: new Date().toISOString(),
  };
  if (existingNew) {
    const { error } = await admin.from("knowledge_base").update(payload).eq("id", existingNew.id);
    if (error) throw error;
    console.log(`  ✓ updated "${NEW_SLUG}"`);
  } else {
    const { data, error } = await admin.from("knowledge_base").insert(payload).select("id").single();
    if (error) throw error;
    console.log(`  ✓ published "${NEW_SLUG}" (${data.id})`);
  }

  const { data: after } = await admin.from("knowledge_base")
    .select("slug, title, published, active, crisis_id").eq("workspace_id", W)
    .or(`slug.eq.${OLD_SLUG},slug.eq.${NEW_SLUG}`);
  console.log("\nverify:");
  for (const a of after || []) console.log(`  ${a.published ? "●" : "○"} ${a.slug} published=${a.published} active=${a.active} crisis=${a.crisis_id ? a.crisis_id.slice(0, 8) : "—"}`);
  console.log("\nNOTE: the new article needs embedding for RAG — the kb-embed-document Inngest fn fires on publish.");
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
