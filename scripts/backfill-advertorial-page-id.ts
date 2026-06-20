/**
 * Backfill storefront_sessions.advertorial_page_id (+ ad_campaign_id) from the
 * landing_url `?angle=` — advertorial-attribution-fix.
 *
 * The lander id was historically stamped only on a session's first INSERT
 * (pixel route), so any session whose first pixel hit created the row without
 * a resolving angle landing_url stayed advertorial_page_id=null forever, even
 * though its landing_url carries an `?angle=` that EXACTLY matches an
 * advertorial_pages.slug. The pixel route now re-resolves set-when-null on
 * later hits; this fills the existing back catalogue.
 *
 * Resolution = the same exact angle→slug match the pixel route + the
 * meta_attribution_daily rollup use: parse `?angle=` from landing_url, match it
 * to an advertorial_pages.slug in the SAME workspace (slug is unique per
 * workspace+product), stamp that page's id + campaign_id. Set-when-null only —
 * we filter on advertorial_page_id IS NULL and never overwrite a non-null.
 *
 * Two-phase + idempotent + resumable: dry-run by default (counts + samples the
 * rows that would change); `--apply` writes. Re-running naturally skips
 * already-stamped rows (the IS NULL filter). Cursor-paginated by id.
 *
 * Scope:
 *   default      — recent window only (first_seen_at within RECENT_DAYS).
 *   --all-time   — the entire back catalogue (no date floor). The all-time
 *                  apply is the gated owner action; run the recent window first.
 *
 * Usage:
 *   npx tsx scripts/backfill-advertorial-page-id.ts                 # recent, dry-run
 *   npx tsx scripts/backfill-advertorial-page-id.ts --apply         # recent, write
 *   npx tsx scripts/backfill-advertorial-page-id.ts --all-time      # all-time, dry-run
 *   npx tsx scripts/backfill-advertorial-page-id.ts --all-time --apply  # all-time, write (gated)
 */

import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const ALL_TIME = process.argv.includes("--all-time");
const RECENT_DAYS = 14;
const PAGE = 1000;
const WRITE_CHUNK = 500;

/** The `?angle={slug}` param off a stored landing_url (the lander identity key). */
function parseAngle(landingUrl: string | null): string | null {
  if (!landingUrl) return null;
  try {
    return new URL(landingUrl).searchParams.get("angle");
  } catch {
    return null;
  }
}

async function main() {
  const admin = createAdminClient();
  const sinceIso = ALL_TIME
    ? null
    : new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();

  console.log(
    `Backfill advertorial_page_id — scope=${ALL_TIME ? "ALL-TIME" : `recent ${RECENT_DAYS}d (since ${sinceIso})`} · mode=${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  // Lander identity: (workspace_id, slug) → { pageId, campaignId }. Slug is
  // unique per workspace+product, so this fully identifies the lander.
  const advBySlug = new Map<string, { pageId: string; campaignId: string | null }>();
  {
    let lastId: string | null = null;
    for (;;) {
      let q = admin
        .from("advertorial_pages")
        .select("id, workspace_id, slug, campaign_id")
        .order("id", { ascending: true })
        .limit(PAGE);
      if (lastId) q = q.gt("id", lastId);
      const { data, error } = await q;
      if (error) throw new Error(`advertorial_pages fetch: ${error.message}`);
      if (!data?.length) break;
      for (const a of data as { id: string; workspace_id: string; slug: string | null; campaign_id: string | null }[]) {
        if (a.slug) advBySlug.set(`${a.workspace_id}::${a.slug}`, { pageId: a.id, campaignId: a.campaign_id });
      }
      lastId = (data[data.length - 1] as { id: string }).id;
      if (data.length < PAGE) break;
    }
  }
  console.log(`Loaded ${advBySlug.size} (workspace, slug) lander keys.`);

  // Walk the null-with-landing_url sessions; resolve each via exact angle→slug.
  // Group the matches by target page so each UPDATE stamps one (page, campaign)
  // across a chunk of ids — still filtered on IS NULL so it stays idempotent.
  const byTarget = new Map<string, { pageId: string; campaignId: string | null; ids: string[] }>();
  let scanned = 0;
  let matched = 0;
  const samples: { id: string; angle: string; pageId: string }[] = [];

  let lastId: string | null = null;
  for (;;) {
    let q = admin
      .from("storefront_sessions")
      .select("id, workspace_id, landing_url, first_seen_at")
      .is("advertorial_page_id", null)
      .not("landing_url", "is", null)
      .order("id", { ascending: true })
      .limit(PAGE);
    if (sinceIso) q = q.gte("first_seen_at", sinceIso);
    if (lastId) q = q.gt("id", lastId);
    const { data, error } = await q;
    if (error) throw new Error(`storefront_sessions fetch: ${error.message}`);
    if (!data?.length) break;
    for (const s of data as { id: string; workspace_id: string; landing_url: string | null; first_seen_at: string }[]) {
      scanned++;
      const slug = parseAngle(s.landing_url);
      if (!slug) continue;
      const target = advBySlug.get(`${s.workspace_id}::${slug}`);
      if (!target) continue;
      matched++;
      const key = `${target.pageId}::${target.campaignId ?? ""}`;
      let bucket = byTarget.get(key);
      if (!bucket) { bucket = { pageId: target.pageId, campaignId: target.campaignId, ids: [] }; byTarget.set(key, bucket); }
      bucket.ids.push(s.id);
      if (samples.length < 10) samples.push({ id: s.id, angle: slug, pageId: target.pageId });
    }
    lastId = (data[data.length - 1] as { id: string }).id;
    if (data.length < PAGE) break;
  }

  console.log(`Scanned ${scanned} null sessions with a landing_url · ${matched} resolve to an exact-match page · ${byTarget.size} distinct target pages.`);
  console.log("Sample matches:");
  for (const s of samples) console.log(`  session ${s.id} · angle="${s.angle}" → page ${s.pageId}`);

  if (!APPLY) {
    console.log(`\nDRY-RUN — would stamp ${matched} sessions. Re-run with --apply${ALL_TIME ? " (all-time apply is the gated owner action)" : ""} to write.`);
    return;
  }

  let updated = 0;
  const t0 = Date.now();
  for (const { pageId, campaignId, ids } of byTarget.values()) {
    for (let i = 0; i < ids.length; i += WRITE_CHUNK) {
      const chunk = ids.slice(i, i + WRITE_CHUNK);
      const { error, count } = await admin
        .from("storefront_sessions")
        .update({ advertorial_page_id: pageId, ad_campaign_id: campaignId }, { count: "exact" })
        .is("advertorial_page_id", null) // set-when-null only — never overwrite
        .in("id", chunk);
      if (error) throw new Error(`update page=${pageId}: ${error.message}`);
      updated += count || 0;
    }
  }
  console.log(`\n✓ DONE — stamped ${updated} sessions in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

main().catch((err) => { console.error("FATAL:", err); process.exit(1); });
