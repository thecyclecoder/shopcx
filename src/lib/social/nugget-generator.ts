/**
 * Nugget generator — AI-drafts educational "nugget" carousel slideshows for the organic library
 * (docs/brain/libraries/nugget-generator.md · organic-nugget-engine Phase 3).
 *
 * One Claude call drafts {title, hook, slides[5–7], dinner_line, study_citation} grounded in the
 * CEO's content rules (2026-11-27): three pillars — body ("how your body really works"), food_first
 * ("natural / food-first prevention + everyday wellness"), superfoods — one real + accurately
 * described study, plain kid-simple words, ≤~20 words per slide, NO disease claims, NO product
 * claims (never imply Superfood Tabs was studied), and a soft brand sign-off only on the last slide.
 *
 * Slides render in two NON-illustrated styles that rotate (the gouache illustrated style is reserved
 * for the animated videos, never slideshows): (a) PHOTO — a realistic photographic background from
 * Nano Banana Pro with NO text baked in; (b) TEXT — a bold solid-color typographic slide. In BOTH,
 * the headline is composited in code (sharp/SVG) so the wording is exact — never drawn by the image
 * model. Output 1080×1350 JPEGs.
 *
 * Supervisable autonomy: it lands drafts (status='draft') via insertOrganicContentDraft; a human
 * approves them in Marketing › Social before anything posts (they make health statements).
 */
import sharp from "sharp";
import path from "path";
import opentype from "opentype.js";
import { createAdminClient } from "@/lib/supabase/admin";
import { SONNET_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { generateNanoBananaProCombine } from "@/lib/gemini";
import { uploadBuffer, AD_BUCKET } from "@/lib/ad-storage";
import {
  insertOrganicContentDraft,
  listQueuedOrganicContent,
  type OrganicContent,
  type OrganicPillar,
  type OrganicSlide,
} from "@/lib/social/organic-content";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const W = 1080, H = 1350; // 4:5 — the one organic carousel ratio (all slides share it)

export const PILLARS: OrganicPillar[] = ["body", "food_first", "superfoods"];

const PILLAR_BRIEF: Record<OrganicPillar, string> = {
  body: "HOW YOUR BODY REALLY WORKS — one surprising, true fact about human physiology (digestion, sleep, energy, hydration, the gut, stress) that makes someone go 'huh, I didn't know that'.",
  food_first: "NATURAL / FOOD-FIRST approaches to prevention and everyday wellness — a simple food or habit people can act on today, framed as support, never as a cure.",
  superfoods: "SUPERFOODS — a genuinely interesting fact about a real superfood ingredient (what it is, where it comes from, what it supports in the body).",
};

// Bold solid-color backgrounds for TEXT slides + the PHOTO overlay band, one palette per pillar.
const PILLAR_COLOR: Record<OrganicPillar, string> = {
  body: "#1F3A5F",
  food_first: "#2E5D34",
  superfoods: "#6B3FA0",
};

export interface NuggetDraft {
  title: string;
  hook: string;
  slides: Array<{ headline: string; body: string }>;
  dinner_line: string;
  study_citation: string;
}

const SYSTEM = `You are a science writer for a superfoods/wellness brand's organic Instagram. You write short, accurate, genuinely shareable "nugget" carousels — the kind of fact someone repeats at the dinner table.

HARD RULES (compliance — a human reviews every draft, so be scrupulously honest):
- Exactly ONE real, verifiable study underpins the carousel. Describe it ACCURATELY. Never exaggerate the finding. study_citation names that ONE study only — never two studies, never a book. If you are not confident the study exists exactly as cited, pick a different, well-known one.
- No "literally" metaphors that misstate the science (e.g. gut serotonin does NOT directly set your mood; say what the study actually showed).
- Use "supports / may help / is linked to" language. NEVER "cures", "treats", "prevents disease", or guaranteed results.
- NEVER claim or imply the brand's product (Superfood Tabs) was itself studied. The study is about an ingredient or a general mechanism, not the product.
- Plain, kid-simple words. No jargon. Max ~20 words per slide.
- 5 to 7 slides. Slide 1 is the hook. The LAST slide is a soft brand sign-off (gentle, no hard sell, no price, no discount).
- Output ONLY valid minified JSON, no markdown, no preamble, matching:
{"title":string,"hook":string,"slides":[{"headline":string,"body":string}],"dinner_line":string,"study_citation":string}
- Slide 1 headline is a surprising, specific, TRUE claim that stops the scroll (a number, a reversal, or a "you've been told X, but…"). Never a bland intro like "Meet X" or "Let's talk about X".
- dinner_line: the single most shareable one-sentence takeaway.

Examples of the bar (style, not topics to copy):
- Hook "Grandma's after-dinner walk was actually right." → 2-5 minutes of walking after a meal blunts the blood sugar spike (Buffey et al., Sports Medicine, 2022). Dinner line: "A short walk after dinner lowers your blood sugar spike."
- Hook "Cut sugar and food starts tasting sweeter." → after 3 months on lower sugar, people rated the same pudding sweeter (Wise et al., Am J Clin Nutr, 2016). Dinner line: "Your taste buds recalibrate in about 3 months."
- Hook "Two short nights of sleep made people about 24% hungrier." (Spiegel et al., Annals of Internal Medicine, 2004).
- study_citation: a short plain-text citation of the real study (authors/journal/year or a well-known finding).`;

function userPrompt(pillar: OrganicPillar, avoidTitles: string[]): string {
  const avoid = avoidTitles.length
    ? `\n\nDo NOT repeat any of these already-made titles (pick a fresh angle):\n- ${avoidTitles.slice(0, 40).join("\n- ")}`
    : "";
  return `Pillar for this nugget: ${PILLAR_BRIEF[pillar]}${avoid}`;
}

/** Ask Claude for one nugget draft. Returns null on failure (caller skips). */
export async function draftNugget(workspaceId: string, pillar: OrganicPillar, avoidTitles: string[]): Promise<NuggetDraft | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: SONNET_MODEL,
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt(pillar, avoidTitles) }],
    }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json?.usage) {
    try { await logAiUsage({ workspaceId, model: SONNET_MODEL, usage: json.usage, purpose: "organic_nugget", ticketId: null }); } catch { /* ignore */ }
  }
  const raw = (json?.content?.[0]?.text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const d = JSON.parse(raw) as NuggetDraft;
    if (!d.title || !Array.isArray(d.slides) || d.slides.length < 5) return null;
    if (!hasSingleStudyCitation(d.study_citation)) return null; // one-study rule (first drafts cited two)
    return d;
  } catch {
    return null;
  }
}

/** One-study rule guard: a citation naming more than one publication year, or chaining studies
 *  with ";" / " and also", cites more than one study. */
export function hasSingleStudyCitation(citation: string | undefined | null): boolean {
  const c = (citation || "").trim();
  if (!c) return false;
  const years = new Set(c.match(/\b(19|20)\d{2}\b/g) || []);
  if (years.size > 1) return false;
  if (/;/.test(c)) return false;
  return true;
}

// ── Slide rendering (headline composited in code — never by the image model) ──

// Text is drawn as vector PATHS from bundled font files (src/lib/social/fonts, OFL Montserrat), not
// as SVG <text>. sharp/librsvg resolves <text> fonts through the host's fontconfig, and the Vercel
// function has no system fonts, so every glyph rendered as a tofu box (first live drafts, 2026-11-28).
// Paths need no font lookup at render time, so slides look the same on Vercel, the box, and local.
const FONT_DIR = path.join(process.cwd(), "src/lib/social/fonts");
let fonts: { bold: opentype.Font; medium: opentype.Font } | null = null;
function loadFonts() {
  if (!fonts) {
    fonts = {
      bold: opentype.loadSync(path.join(FONT_DIR, "Montserrat-ExtraBold.ttf")),
      medium: opentype.loadSync(path.join(FONT_DIR, "Montserrat-Medium.ttf")),
    };
  }
  return fonts;
}

/** Greedy word-wrap by real rendered width (not character count). */
export function wrapByWidth(font: opentype.Font, text: string, size: number, maxWidth: number): string[] {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && font.getAdvanceWidth(next, size) > maxWidth) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

interface TextBlock { lines: string[]; size: number; lineHeight: number; font: opentype.Font }

/** Fit text into maxLines by stepping the font size down; returns the wrapped block. */
function fitBlock(font: opentype.Font, text: string, maxSize: number, minSize: number, maxWidth: number, maxLines: number, leading = 1.18): TextBlock {
  let size = maxSize;
  let lines = wrapByWidth(font, text, size, maxWidth);
  while (lines.length > maxLines && size > minSize) {
    size -= 4;
    lines = wrapByWidth(font, text, size, maxWidth);
  }
  return { lines, size, lineHeight: Math.round(size * leading), font };
}

/** Centered lines as SVG <path> elements. `top` = top edge of the block. */
function blockPaths(b: TextBlock, top: number, fill: string): string {
  return b.lines.map((ln, i) => {
    const width = b.font.getAdvanceWidth(ln, b.size);
    const baseline = top + i * b.lineHeight + b.size * 0.8;
    const d = b.font.getPath(ln, (W - width) / 2, baseline, b.size).toPathData(2);
    return `<path d="${d}" fill="${fill}"/>`;
  }).join("");
}

const blockHeight = (b: TextBlock) => (b.lines.length ? b.lines.length * b.lineHeight : 0);
const MAX_TEXT_W = W - 2 * 96;

/** A bold solid-color typographic slide: headline + body centered, exact wording. */
export function textSlideSvg(headline: string, body: string, bg: string): string {
  const { bold, medium } = loadFonts();
  const hb = fitBlock(bold, headline, 88, 56, MAX_TEXT_W, 5);
  const bb = fitBlock(medium, body || "", 44, 32, MAX_TEXT_W, 7, 1.35);
  const gap = bb.lines.length ? 56 : 0;
  const total = blockHeight(hb) + gap + blockHeight(bb);
  const top = Math.round((H - total) / 2);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${bg}"/>` +
    blockPaths(hb, top, "#FFFFFF") + (bb.lines.length ? blockPaths(bb, top + blockHeight(hb) + gap, "#EDEDED") : "") + `</svg>`;
}

/** Headline + body on a solid band over the lower part of a photographic background. */
export function photoOverlaySvg(headline: string, body: string, bandColor: string): string {
  const { bold, medium } = loadFonts();
  const hb = fitBlock(bold, headline, 72, 48, MAX_TEXT_W, 3);
  const bb = fitBlock(medium, body || "", 38, 28, MAX_TEXT_W, 4, 1.35);
  const pad = 64, gap = bb.lines.length ? 28 : 0;
  const bandH = Math.min(Math.round(H * 0.55), pad * 2 + blockHeight(hb) + gap + blockHeight(bb));
  const bandTop = H - bandH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="0" y="${bandTop}" width="${W}" height="${bandH}" fill="${bandColor}" fill-opacity="0.88"/>` +
    blockPaths(hb, bandTop + pad, "#FFFFFF") + (bb.lines.length ? blockPaths(bb, bandTop + pad + blockHeight(hb) + gap, "#EDEDED") : "") + `</svg>`;
}

/** Render one slide JPEG (4:5). Style 'photo' needs Gemini; falls back to 'text' if it fails. */
async function renderSlide(
  workspaceId: string, pillar: OrganicPillar, style: "photo" | "text", headline: string, body: string,
): Promise<Buffer> {
  const bg = PILLAR_COLOR[pillar];
  if (style === "photo") {
    try {
      const prompt = `A realistic, editorial, well-lit PHOTOGRAPH for a wellness carousel slide about: "${headline}". Natural food, ingredients, people, or everyday scenes. NO text, NO words, NO letters, NO logos anywhere in the image. Clean, modern, documentary style. Vertical 4:5.`;
      const { buffer } = await generateNanoBananaProCombine({ workspaceId, prompt, imageUrls: [], aspectRatio: "4:5" });
      const base = await sharp(buffer).resize(W, H, { fit: "cover" }).toBuffer();
      return await sharp(base)
        .composite([{ input: Buffer.from(photoOverlaySvg(headline, body, bg)), top: 0, left: 0 }])
        .jpeg({ quality: 88 })
        .toBuffer();
    } catch {
      // Gemini not connected / billing off — degrade to a clean text slide, never fail the nugget.
    }
  }
  return await sharp(Buffer.from(textSlideSvg(headline, body, bg))).jpeg({ quality: 88 }).toBuffer();
}

function slugify(s: string): string {
  return (s || "nugget").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "nugget";
}

/**
 * Generate ONE nugget carousel for a pillar: draft via Claude, render every slide, upload the JPEGs,
 * and insert the draft into the organic library (status='draft'). Dedupes against existing
 * organic_content carousel titles. Returns the inserted row, or null if nothing was produced.
 */
export async function generateNugget(workspaceId: string, pillar: OrganicPillar): Promise<OrganicContent | null> {
  const admin = createAdminClient();
  const queued = await listQueuedOrganicContent(admin, workspaceId, "carousel");
  const existingTitles = queued.map((c) => (c.title || "").toLowerCase().trim()).filter(Boolean);

  const draft = await draftNugget(workspaceId, pillar, queued.map((c) => c.title || "").filter(Boolean));
  if (!draft) return null;
  // Dedupe: skip if a carousel with the same title already exists (draft or approved).
  if (existingTitles.includes(draft.title.toLowerCase().trim())) return null;

  const key = `${slugify(draft.title)}-${Date.now()}`;
  const slides: OrganicSlide[] = [];
  for (let i = 0; i < draft.slides.length; i++) {
    const s = draft.slides[i];
    const style: "photo" | "text" = i % 2 === 0 ? "photo" : "text"; // rotate the two non-illustrated styles
    const buf = await renderSlide(workspaceId, pillar, style, s.headline, s.body);
    const path = `organic/nuggets/${workspaceId}/${key}/${i}.jpg`;
    await uploadBuffer(path, buf, "image/jpeg");
    slides.push({ headline: s.headline, body: s.body, image_bucket: AD_BUCKET, image_path: path });
  }

  return insertOrganicContentDraft(admin, workspaceId, {
    format: "carousel",
    pillar,
    title: draft.title,
    hook: draft.hook,
    slides,
    dinner_line: draft.dinner_line,
    study_citation: draft.study_citation,
    created_by: "nugget_generator",
    status: "draft",
  });
}

/**
 * Keep ≥`target` carousels queued (draft-or-approved) for a workspace, generating across the three
 * pillars in rotation. Returns how many were created this run.
 */
export async function topUpNuggetQueue(workspaceId: string, target = 7): Promise<number> {
  const admin = createAdminClient();
  let queued = (await listQueuedOrganicContent(admin, workspaceId, "carousel")).length;
  let created = 0;
  // Cap the per-run work so a cold start doesn't try to mint 7 at once (cost + API load).
  const maxPerRun = 3;
  while (queued < target && created < maxPerRun) {
    const pillar = PILLARS[(queued + created) % PILLARS.length];
    const made = await generateNugget(workspaceId, pillar);
    if (!made) break; // draft failed or deduped — stop rather than spin
    created++;
    queued++;
  }
  return created;
}
