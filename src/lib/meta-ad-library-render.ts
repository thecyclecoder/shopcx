/**
 * Creative rendering for Meta Ad Library ads — BOX ONLY.
 *
 * Meta's archive exposes no media url. The one field that carries the creative is
 * `ad_snapshot_url`, a JS-rendered page, so obtaining bytes requires a real browser. Everything
 * cheaper was tried and failed (2026-08-24, live):
 *
 *   | route                                   | result                                          |
 *   |-----------------------------------------|-------------------------------------------------|
 *   | bare fetch of the snapshot url          | HTTP 200, 174KB shell, 0 creative urls          |
 *   | same + browser User-Agent               | HTTP 400 (Meta rejects it)                      |
 *   | `facebook.com/ads/library/?id=` permalink | HTTP 403                                      |
 *   | graph `doc_id` route                    | needs an `lsd` token off the permalink → 403    |
 *
 * ⚠️ WHY THIS FILE NEVER RUNS ON VERCEL. Playwright is imported DYNAMICALLY so that merely
 * importing this module (e.g. from a shared type) can't pull chromium into a serverless bundle.
 * The render step is dispatched to the box, where Playwright already lives for
 * `scripts/research-capture.ts`. Calling it from an Inngest function on Vercel will throw.
 *
 * The signed `scontent.*.fbcdn.net` url the page yields carries `oh=`/`oe=` expiry params and 403s
 * from outside the page context — so we fetch the bytes INSIDE the page and hand back a Buffer.
 * Never store that url; store the bytes (which is what `creative_skeletons.thumb_path` already does).
 */
import { CreativeRenderError, type NormalizedAd } from "@/lib/competitor-ad-types";

export interface RenderedCreative {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
}

/** Long enough for the creative to lazy-load, short enough that a dead ad fails fast. */
const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 1_500;
const LAZY_MS = 2_500;
const IMG_WAIT_MS = 8_000;
/** Anything under this is page chrome (the 60px advertiser avatar), not the creative. */
const MIN_CREATIVE_PX = 150;

/** In-page extraction. Returns base64 because the signed CDN url 403s outside the page context. */
const EXTRACT = `async () => {
  const imgs = [...document.querySelectorAll('img')].filter(i => i.naturalWidth >= ${MIN_CREATIVE_PX});
  if (!imgs.length) return null;
  // Largest by area — the creative, never an avatar or icon.
  imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight));
  const img = imgs[0];
  const res = await fetch(img.currentSrc);
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let n = 0; n < buf.length; n++) bin += String.fromCharCode(buf[n]);
  return {
    b64: btoa(bin),
    width: img.naturalWidth,
    height: img.naturalHeight,
    contentType: res.headers.get('content-type') || 'image/jpeg',
  };
}`;

/**
 * A reusable browser for a batch of renders. Launching chromium per ad is the dominant cost, so the
 * scout renders a whole competitor's statics through ONE session.
 */
export class CreativeRenderer {
  // `any` here is deliberate: typing these as playwright's Browser/Page would force a static import
  // of the module we are specifically avoiding importing statically.
  private browser: unknown = null;
  private page: unknown = null;

  async open(): Promise<void> {
    if (this.browser) return;
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
    this.browser = browser;
    this.page = await ctx.newPage();
  }

  async close(): Promise<void> {
    const browser = this.browser as { close?: () => Promise<void> } | null;
    if (browser?.close) await browser.close().catch(() => {});
    this.browser = null;
    this.page = null;
  }

  /**
   * Render ONE ad's creative to bytes.
   * @throws {CreativeRenderError} `permanent:true` when the ad has no creative to render.
   */
  async render(snapshotUrl: string): Promise<RenderedCreative> {
    if (!this.page) await this.open();
    const page = this.page as {
      goto: (u: string, o: unknown) => Promise<unknown>;
      waitForTimeout: (ms: number) => Promise<void>;
      mouse: { wheel: (x: number, y: number) => Promise<void> };
      waitForFunction: (fn: string, o: unknown) => Promise<unknown>;
      evaluate: (fn: string) => Promise<unknown>;
    };

    await page.goto(snapshotUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    // Some ads (notably on affiliate pages) only load the creative once it nears the viewport.
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(LAZY_MS);
    await page
      .waitForFunction(
        `() => [...document.querySelectorAll('img')].some(i => i.naturalWidth >= ${MIN_CREATIVE_PX})`,
        { timeout: IMG_WAIT_MS },
      )
      .catch(() => {
        /* fall through — the extract below reports the real reason */
      });

    const got = (await page.evaluate(EXTRACT)) as {
      b64: string;
      width: number;
      height: number;
      contentType: string;
    } | null;

    if (!got) {
      throw new CreativeRenderError(
        `no creative rendered for ${snapshotUrl.slice(0, 80)} — Meta most likely stripped it`,
        true,
      );
    }
    return {
      buffer: Buffer.from(got.b64, "base64"),
      contentType: got.contentType,
      width: got.width,
      height: got.height,
    };
  }
}

/**
 * Render a batch of ads, skipping the ones that can't have a creative.
 *
 * Filtering Meta-removed ads up front is what took a live Erth pass from 14/26 to 22/22 — the 12
 * failures were ALL ads Meta had taken down, whose snapshot renders copy and a 60px avatar and
 * nothing else. They are unrenderable by construction, so attempting them is pure wasted page-loads.
 */
export async function renderCreatives(
  ads: NormalizedAd[],
  opts: { onRendered?: (ad: NormalizedAd, c: RenderedCreative) => Promise<void>; pauseMs?: number } = {},
): Promise<{ rendered: number; skipped: number; failed: number }> {
  const renderable = ads.filter((a) => a.creative_url && a.media_type === "static");
  const skipped = ads.length - renderable.length;
  if (!renderable.length) return { rendered: 0, skipped, failed: 0 };

  const renderer = new CreativeRenderer();
  let rendered = 0;
  let failed = 0;
  try {
    await renderer.open();
    for (const [i, ad] of renderable.entries()) {
      try {
        const creative = await renderer.render(ad.creative_url!);
        await opts.onRendered?.(ad, creative);
        rendered++;
      } catch (err) {
        failed++;
        const permanent = err instanceof CreativeRenderError && err.permanent;
        console.error(
          `[meta-ad-library] render ${permanent ? "unavailable" : "failed"} for ${ad.ad_key}:`,
          err instanceof Error ? err.message : err,
        );
      }
      if (i < renderable.length - 1) await new Promise((r) => setTimeout(r, opts.pauseMs ?? 800));
    }
  } finally {
    await renderer.close();
  }
  return { rendered, skipped, failed };
}
