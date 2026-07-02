// landing-page-snapshot — the headless-browser capture for Landing Page Scout
// (docs/brain/specs/landing-page-scout.md, Phase 1). Playwright can't run in serverless/Inngest, so
// the mobile per-chapter snapshotter is a BOX script (companion to scripts/spec-test-browser-check.ts).
//
// For a workspace (optionally one product) it:
//   1. reads loadLanderTargets() — competitor landers (ad-creative-scout ad destinations + competitor-scout
//      PDP URLs) + our storefront PDP(s).
//   2. renders each at a PHONE viewport, scrolls section-by-section, captures per-chapter screenshots:
//        - ours:        one shot per <section data-section> (StorefrontChapterTracker anchors), each
//                       PAIRED with that chapter's funnel stats (dwell %, view→CTA %) via loadChapterStats.
//        - competitors: one shot per viewport-height scroll step (no anchors to read).
//   3. uploads each shot to the PRIVATE `lander-shots` bucket + writes a lander_snapshots row.
//   4. (default) runs the vision gap-analysis pass → proposed lander_recommendations.
//
// 🚨 A competitor lander that fails to load (bot-block / 4xx-5xx / timeout) is logged as
// status='blocked'|'failed' and SKIPPED — never a hard pipeline failure.
//
// Usage:
//   npx tsx scripts/landing-page-snapshot.ts --workspace-id <uuid> [--product-id <uuid>] [--no-analyze]
import { chromium } from "playwright";
import { createAdminClient } from "./_bootstrap";
import {
  loadLanderTargets,
  loadChapterStats,
  uploadLanderShot,
  ensureLanderShotsBucket,
  analyzeLanderGaps,
  extractCtaTarget,
  deconstructLander,
  DEFAULT_FUNNEL_DEPTH,
  type LanderTarget,
  type ChapterStat,
} from "../src/lib/landing-page-scout";

const NAV_TIMEOUT_MS = 30_000;
const MAX_CHAPTERS = 12;
const PHONE = { width: 390, height: 844 };
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

type Args = { workspaceId: string; productId: string | null; analyze: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { workspaceId: "", productId: null, analyze: true };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--workspace-id": a.workspaceId = v; i++; break;
      case "--product-id": a.productId = v; i++; break;
      case "--no-analyze": a.analyze = false; break;
    }
  }
  if (!a.workspaceId) throw new Error("--workspace-id is required");
  return a;
}

const safe = (s: string) => (s || "x").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);

interface CapturedChapter {
  index: number;
  label: string;
  screenshot_path: string;
  dwell_pct?: number;
  avg_dwell_ms?: number;
  view_to_cta_pct?: number;
  reach_sessions?: number;
}

/** Capture one lander → its per-chapter shots + collected anchor hrefs (or a blocked/failed marker). */
async function captureLander(
  target: LanderTarget,
  stamp: string,
  chapterStats: Record<string, ChapterStat>,
): Promise<{ status: "captured" | "blocked" | "failed"; chapters: CapturedChapter[]; hrefs: string[]; error: string | null }> {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      userAgent: MOBILE_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const resp = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }).catch(() => null);
    const httpStatus = resp?.status() ?? 0;
    if (!resp || httpStatus >= 400) {
      return { status: "blocked", chapters: [], hrefs: [], error: `nav http ${httpStatus || "no-response"}` };
    }
    await page.waitForTimeout(1200); // let lazy sections hydrate

    const chapters: CapturedChapter[] = [];
    const pathFor = (i: number) => `${target.product_id || "ws"}/${stamp}/${safe(target.brand || "x")}/chapter-${i}.png`;

    if (target.is_ours) {
      // Ours: one shot per StorefrontChapterTracker section, paired with funnel stats.
      const sections = await page.$$("section[data-section]");
      const limited = sections.slice(0, MAX_CHAPTERS);
      for (let i = 0; i < limited.length; i++) {
        const el = limited[i];
        const label = (await el.getAttribute("data-section")) || `section-${i}`;
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(350);
        const shot = await el.screenshot().catch(() => null);
        if (!shot) continue;
        const path = await uploadLanderShot(pathFor(i), shot);
        const stat = chapterStats[label];
        chapters.push({
          index: i,
          label,
          screenshot_path: path,
          avg_dwell_ms: stat?.avg_dwell_ms,
          view_to_cta_pct: stat?.view_to_cta_pct,
          reach_sessions: stat?.reach_sessions,
        });
      }
    } else {
      // Competitors: no anchors — chunk by viewport-height scroll steps.
      const pageHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => PHONE.height);
      const steps = Math.min(MAX_CHAPTERS, Math.max(1, Math.ceil(pageHeight / PHONE.height)));
      for (let i = 0; i < steps; i++) {
        await page.evaluate((y) => window.scrollTo(0, y), i * PHONE.height).catch(() => {});
        await page.waitForTimeout(350);
        const shot = await page.screenshot().catch(() => null);
        if (!shot) continue;
        const path = await uploadLanderShot(pathFor(i), shot);
        chapters.push({ index: i, label: `section-${i}`, screenshot_path: path });
      }
    }

    // Collect all anchor hrefs so the funnel-follow can rank the primary CTA destination
    // (docs/brain/specs/funnel-teardown-scout.md, Phase 1). Runs unconditionally; extractCtaTarget
    // returns null for our own landers (no outbound same-brand target) so nothing is followed.
    const hrefs = await page
      .$$eval("a[href]", (els) => els.map((e) => (e as HTMLAnchorElement).getAttribute("href") || "").filter(Boolean))
      .catch(() => [] as string[]);

    if (!chapters.length) return { status: "failed", chapters: [], hrefs, error: "no chapters captured" };
    return { status: "captured", chapters, hrefs, error: null };
  } catch (e) {
    return { status: "failed", chapters: [], hrefs: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const admin = createAdminClient();
  await ensureLanderShotsBucket();

  const targets = await loadLanderTargets(args.workspaceId, args.productId);
  if (!targets.length) {
    console.log(JSON.stringify({ ok: true, captured: 0, note: "no lander targets (no approved competitors / products)" }));
    return;
  }
  const chapterStats = await loadChapterStats(args.workspaceId, args.productId);

  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const summary: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    // Funnel walk: for a competitor lander, capture the entry (step 0) and then follow the extracted
    // primary CTA one step at a time up to DEFAULT_FUNNEL_DEPTH (funnel-teardown-scout Phase 1). Our
    // own lander gets a single capture (no funnel-follow — this is a competitive-research tool).
    // Depth is bounded; a blocked step stops that branch (never a hard failure); dedup prevents a
    // repeat CTA loop within one run.
    const maxDepth = target.is_ours ? 1 : DEFAULT_FUNNEL_DEPTH;
    const funnelRoot = target.url;
    const seen = new Set<string>();
    let currentTarget: LanderTarget | null = target;

    for (let step = 0; step < maxDepth && currentTarget; step++) {
      if (seen.has(currentTarget.url)) break; // dedup
      seen.add(currentTarget.url);

      const cap = await captureLander(currentTarget, stamp, chapterStats);
      const ctaTarget = cap.status === "captured" ? extractCtaTarget(cap.hrefs, currentTarget.url) : null;
      const { data: inserted, error } = await admin.from("lander_snapshots").insert({
        workspace_id: args.workspaceId,
        product_id: currentTarget.product_id,
        competitor_id: currentTarget.competitor_id,
        is_ours: currentTarget.is_ours,
        brand: currentTarget.brand,
        url: currentTarget.url,
        source: currentTarget.source,
        viewport: "mobile",
        status: cap.status,
        chapters: cap.chapters,
        error: cap.error,
        captured_at: new Date().toISOString(),
        funnel_step: step,
        funnel_root_url: funnelRoot,
        cta_target_url: ctaTarget,
      }).select("id").maybeSingle();

      // Vision-deconstruct each captured step into its page-type-aware skeleton
      // (Funnel Teardown Scout, Phase 2). Bounded cost, idempotent, non-fatal.
      let pageType: string | null = null;
      let deconstructError: string | null = null;
      if (cap.status === "captured" && inserted?.id) {
        try {
          const d = await deconstructLander(args.workspaceId, {
            id: inserted.id,
            chapters: cap.chapters,
            url: currentTarget.url,
          });
          pageType = d?.page_type ?? null;
        } catch (e) {
          deconstructError = e instanceof Error ? e.message : String(e);
        }
      }

      summary.push({
        url: currentTarget.url,
        brand: currentTarget.brand,
        is_ours: currentTarget.is_ours,
        status: cap.status,
        chapters: cap.chapters.length,
        funnel_step: step,
        cta_target_url: ctaTarget,
        page_type: pageType,
        insertError: error?.message || null,
        deconstructError,
      });
      console.log(
        `${cap.status === "captured" ? "✓" : "⊘"} step=${step} ${currentTarget.brand} ${currentTarget.url} → ${cap.status} (${cap.chapters.length} chapters)${ctaTarget ? ` → CTA ${ctaTarget}` : ""}${pageType ? ` [${pageType}]` : ""}`,
      );

      // Stop this branch on non-captured or when there's no further outbound-brand CTA to follow.
      if (cap.status !== "captured" || !ctaTarget || seen.has(ctaTarget)) break;
      currentTarget = {
        url: ctaTarget,
        source: currentTarget.source,
        is_ours: currentTarget.is_ours,
        brand: currentTarget.brand,
        competitor_id: currentTarget.competitor_id,
        product_id: currentTarget.product_id,
      };
    }
  }

  let analysis: unknown = null;
  if (args.analyze) {
    analysis = await analyzeLanderGaps(args.workspaceId, args.productId).catch((e) => ({ error: String(e) }));
    console.log("✓ gap-analysis:", JSON.stringify(analysis));
  }

  console.log(JSON.stringify({ ok: true, captured: summary.length, summary, analysis }, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});
