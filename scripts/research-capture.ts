/**
 * research-capture — the headless-browser capture half of Rhea's URL sensor
 * (docs/brain/specs/rhea-url-sensor.md, Phase 2).
 *
 * A box helper (Playwright can't run in serverless / Inngest). Given a research_urls row it renders
 * the destination at a MOBILE viewport, kills any full-viewport overlay before every screenshot
 * (the proven fix for the erthlabs scroll-triggered "scratch-to-win" interstitial), and produces a
 * chaptered capture:
 *   - DOM-first — if the page exposes a sane `<section>` / `[data-section]` map (reasonable count,
 *     sized, some headings), one `element.screenshot()` per section (the erthlabs advertorial → 17
 *     clean chapters).
 *   - Vision-tile fallback — for pages with no usable sections (the PageFly PDP path), overlapping
 *     viewport-tile scroll shots (90% step) the agent reads.
 * Bot-block flakiness → retry the navigation N times; a persistent failure returns status='unviewable'
 * (which Rhea's classifier records as unviewable, NOT not_worthy — see Phase 1 SDK vocabulary).
 *
 * Screenshots are uploaded to the private `research-shots` bucket; the returned manifest is the
 * shot-path list Rhea's box session reads to classify.
 *
 * The worker (scripts/builder-worker.ts → runResearchJob) is the ONLY caller. Reused as a subprocess
 * driver too — see `main()` at the bottom.
 */
import { chromium, type Browser, type Page } from "playwright";
import { errText } from "../src/lib/error-text";
import { createAdminClient } from "./_bootstrap";

/** Mobile capture parity with scripts/landing-page-snapshot.ts + the Landing Page Scout spec. */
const PHONE = { width: 390, height: 844 };
const DEVICE_SCALE_FACTOR = 2;
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const NAV_TIMEOUT_MS = 30_000;
/** Bot-block flakiness retry count — a persistent failure yields status='unviewable'. */
const NAV_RETRIES = 3;
/** DOM-first threshold — need at least this many <section>/[data-section] elements to trust the map. */
const DOM_SECTIONS_MIN = 3;
/** DOM-first upper bound — a page with 200 sections has probably tagged every UL li; fall back to tiles. */
const DOM_SECTIONS_MAX = 40;
/** Cap the number of chapters we upload per URL — an outlier lander can't blow the budget. */
const CAPTURED_CHAPTERS_MAX = 30;
/** Scroll-tile step — 90% of viewport height keeps a small overlap so chapters don't miss content on a boundary. */
const TILE_STEP_RATIO = 0.9;

export const RESEARCH_SHOTS_BUCKET = "research-shots";

export interface ResearchCaptureInput {
  id: string;
  url: string;
}

export interface ResearchCaptureChapter {
  index: number;
  label: string;
  screenshot_path: string;
}

export type ResearchCaptureStatus = "captured" | "unviewable";

export interface ResearchCaptureResult {
  id: string;
  url: string;
  status: ResearchCaptureStatus;
  strategy: "dom" | "tile" | "none";
  chapters: ResearchCaptureChapter[];
  capture_ref: string | null;
  error: string | null;
}

// ── Storage ───────────────────────────────────────────────────────────────────

async function ensureBucket(): Promise<void> {
  const admin = createAdminClient();
  const { data } = await admin.storage.getBucket(RESEARCH_SHOTS_BUCKET);
  if (!data) await admin.storage.createBucket(RESEARCH_SHOTS_BUCKET, { public: false });
}

async function uploadShot(path: string, buffer: Buffer): Promise<string> {
  const admin = createAdminClient();
  const { error } = await admin.storage.from(RESEARCH_SHOTS_BUCKET).upload(path, buffer, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) throw new Error(`research_shot_upload: ${error.message}`);
  return path;
}

// ── Capture primitives ────────────────────────────────────────────────────────

const safe = (s: string) => (s || "x").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40);

/**
 * Remove any fixed/absolute element covering most of the viewport BEFORE every screenshot — the
 * proven fix for the erthlabs scroll-triggered "scratch-to-win" interstitial (it re-fires on scroll,
 * so a one-shot dismiss doesn't survive). Also kill CSS animations so a scroll-triggered fade
 * doesn't wash a chapter shot. Idempotent + non-fatal (best-effort).
 */
async function killOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const removed: Element[] = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "absolute") continue;
      const r = el.getBoundingClientRect();
      // Anything covering ≥60% of the viewport in BOTH dimensions is treated as an overlay.
      if (r.width >= vw * 0.6 && r.height >= vh * 0.6) removed.push(el);
    }
    for (const el of removed) el.remove();
    // Kill animations / transitions so a scroll-triggered fade doesn't smear a shot.
    const style = document.createElement("style");
    style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; }";
    document.head.appendChild(style);
  }).catch(() => {
    /* best-effort; a page that crashes on the evaluate call still gets its shots */
  });
}

async function loadWithRetry(page: Page, url: string): Promise<{ ok: boolean; error: string | null }> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= NAV_RETRIES; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      const s = resp?.status() ?? 0;
      if (resp && s < 400) {
        await page.waitForTimeout(1200); // let lazy sections hydrate
        return { ok: true, error: null };
      }
      lastError = `http ${s || "no-response"}`;
    } catch (e) {
      lastError = errText(e);
    }
    if (attempt < NAV_RETRIES) await page.waitForTimeout(1500 * attempt);
  }
  return { ok: false, error: lastError || "nav_failed" };
}

/**
 * DOM-first chaptering: return the `<section>` / `[data-section]` map when it looks sane, or null
 * when we should fall back to vision-tile capture. Sane = between DOM_SECTIONS_MIN and DOM_SECTIONS_MAX
 * elements, each with a non-zero rendered box, and at least one carrying a heading — the last
 * criterion filters PDPs that tag every `<li>` as a section.
 */
async function pickDomChapters(page: Page): Promise<Array<{ label: string; selectorIndex: number }> | null> {
  return page.evaluate(
    ({ min, max }) => {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("section, [data-section]"),
      );
      if (nodes.length < min || nodes.length > max) return null;
      let headings = 0;
      const out: Array<{ label: string; selectorIndex: number }> = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const r = n.getBoundingClientRect();
        if (r.height < 40) continue; // skip a zero-height wrapper
        const dataSection = n.getAttribute("data-section");
        const heading = n.querySelector("h1, h2, h3");
        if (heading) headings++;
        const label =
          dataSection ||
          (heading?.textContent || "").trim().slice(0, 60) ||
          `section-${i}`;
        out.push({ label: label || `section-${i}`, selectorIndex: i });
      }
      if (out.length < min) return null;
      if (headings === 0) return null; // no heading → likely a PDP that tagged every li → fall back
      return out;
    },
    { min: DOM_SECTIONS_MIN, max: DOM_SECTIONS_MAX },
  );
}

async function captureDom(
  page: Page,
  chapters: Array<{ label: string; selectorIndex: number }>,
  pathFor: (i: number) => string,
): Promise<ResearchCaptureChapter[]> {
  const out: ResearchCaptureChapter[] = [];
  const handles = await page.$$("section, [data-section]");
  const limit = Math.min(chapters.length, CAPTURED_CHAPTERS_MAX);
  for (let i = 0; i < limit; i++) {
    const c = chapters[i];
    const el = handles[c.selectorIndex];
    if (!el) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(350);
    await killOverlays(page); // overlay re-fires on scroll — kill BEFORE every shot
    const shot = await el.screenshot().catch(() => null);
    if (!shot) continue;
    const path = await uploadShot(pathFor(i), shot);
    out.push({ index: i, label: c.label, screenshot_path: path });
  }
  return out;
}

async function captureTiles(page: Page, pathFor: (i: number) => string): Promise<ResearchCaptureChapter[]> {
  const pageHeight = await page.evaluate(() => document.body.scrollHeight).catch(() => PHONE.height);
  const step = Math.max(1, Math.floor(PHONE.height * TILE_STEP_RATIO));
  const steps = Math.min(CAPTURED_CHAPTERS_MAX, Math.max(1, Math.ceil(pageHeight / step)));
  const out: ResearchCaptureChapter[] = [];
  for (let i = 0; i < steps; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * step).catch(() => {});
    await page.waitForTimeout(350);
    await killOverlays(page); // overlay re-fires on scroll — kill BEFORE every shot
    const shot = await page.screenshot().catch(() => null);
    if (!shot) continue;
    const path = await uploadShot(pathFor(i), shot);
    out.push({ index: i, label: `tile-${i}`, screenshot_path: path });
  }
  return out;
}

/** Capture ONE research_urls URL. Idempotent-ish — a re-run overwrites (upsert:true on upload). */
export async function captureOne(input: ResearchCaptureInput, stamp: string): Promise<ResearchCaptureResult> {
  const browser: Browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const captureRef = `${stamp}/${input.id}`;
  const pathFor = (i: number) => `${captureRef}/${safe(input.url)}-chapter-${i}.png`;
  try {
    const context = await browser.newContext({
      viewport: PHONE,
      userAgent: MOBILE_UA,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });
    const page = await context.newPage();

    const nav = await loadWithRetry(page, input.url);
    if (!nav.ok) {
      return {
        id: input.id,
        url: input.url,
        status: "unviewable",
        strategy: "none",
        chapters: [],
        capture_ref: null,
        error: nav.error,
      };
    }

    await killOverlays(page);

    const dom = await pickDomChapters(page).catch(() => null);
    let chapters: ResearchCaptureChapter[];
    let strategy: "dom" | "tile";
    if (dom && dom.length >= DOM_SECTIONS_MIN) {
      chapters = await captureDom(page, dom, pathFor);
      strategy = "dom";
    } else {
      chapters = await captureTiles(page, pathFor);
      strategy = "tile";
    }

    if (!chapters.length) {
      return {
        id: input.id,
        url: input.url,
        status: "unviewable",
        strategy,
        chapters: [],
        capture_ref: null,
        error: "no chapters captured",
      };
    }

    return {
      id: input.id,
      url: input.url,
      status: "captured",
      strategy,
      chapters,
      capture_ref: captureRef,
      error: null,
    };
  } catch (e) {
    return {
      id: input.id,
      url: input.url,
      status: "unviewable",
      strategy: "none",
      chapters: [],
      capture_ref: null,
      error: errText(e),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Capture a batch. Sequential (a single Chromium at a time keeps memory bounded on the box) and
 * best-effort per URL — a crash on one URL never wedges the rest.
 */
export async function captureBatch(
  inputs: ResearchCaptureInput[],
  stamp: string,
  onProgress?: (done: number, total: number, url: string) => void | Promise<void>,
): Promise<ResearchCaptureResult[]> {
  await ensureBucket();
  const out: ResearchCaptureResult[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    // Un-black-box the capture phase: report which URL we're about to render (the box card
    // otherwise sits silent through the whole Playwright pass — no claude session exists yet).
    await Promise.resolve(onProgress?.(i, inputs.length, input.url)).catch(() => {});
    const r = await captureOne(input, stamp).catch((e) => ({
      id: input.id,
      url: input.url,
      status: "unviewable" as const,
      strategy: "none" as const,
      chapters: [],
      capture_ref: null,
      error: errText(e),
    }));
    out.push(r);
  }
  return out;
}

// ── Standalone CLI (for manual runs / debugging) ─────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const inputs: ResearchCaptureInput[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) {
      inputs.push({ id: `manual-${inputs.length}`, url: argv[i + 1] });
      i++;
    }
  }
  if (!inputs.length) {
    console.error("usage: npx tsx scripts/research-capture.ts --url <url> [--url <url> ...]");
    process.exit(1);
  }
  const stamp = `manual-${Date.now()}`;
  const results = await captureBatch(inputs, stamp);
  console.log(JSON.stringify({ ok: true, stamp, results }, null, 2));
}

// Only run main() when invoked as a script (not when imported by builder-worker).
if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify({ ok: false, error: errText(e) }));
    process.exit(1);
  });
}
