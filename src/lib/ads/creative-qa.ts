/**
 * creative-qa — the visual gate the Ad Creative Agent (Dahlia) runs on every generated static before
 * it lands in [[media-buyer-agent|Bianca]]'s ready-to-test bin. The [[creative-brief]] guarantees the
 * CLAIMS are true by construction (grounded in [[../product-intelligence]]); what a text-to-image model
 * can still get wrong is the RENDER — garbled/dropped headline text, a bare sticker price, a cartoon
 * "before/after", or a fabricated authenticity caption ("Candid photos from her home"). Those are all
 * VISUAL defects, so we check them with a vision pass rather than trusting the prompt.
 *
 * Two paths, same verdict shape:
 *   - qaCreative (legacy) — direct Opus vision API call (needs ANTHROPIC_API_KEY). Kept as the
 *     Phase 2 kill-switch fallback for DAHLIA_QC_MODE=direct.
 *   - qaCreativeViaBoxSession (Phase 1 default) — spawns a top-level `claude -p` on Max via a
 *     caller-supplied dispatcher; no ANTHROPIC_API_KEY required. The Node lane
 *     ([[creative-agent]] runAdCreativeLoop, dispatched by scripts/builder-worker.ts
 *     runAdCreativeJob) is the only mutator — it regenerates on `pass:false` up to the retry cap,
 *     then inserts the passer into public.ad_campaigns (status='ready').
 *
 * Both fail CLOSED: any dispatch error / unparseable verdict / undecodable image resolves to
 * `pass:false` so nothing unchecked reaches the bin. See
 * [[../../../docs/brain/reference/meta-scaling-methodology]] (price-on-static + fabrication rules).
 */
import { randomUUID } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import type { GeneratedCreative } from "@/lib/ads/creative-generate";
import { buildQcPrompt } from "@/lib/ads/creative-qc-sandbox";
import { validateGeneratedCopy, type ValidatorResult, type ValidatorContext } from "@/lib/ads/copy-validator";
import type { CreativeBrief } from "@/lib/ads/creative-brief";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

export interface CreativeQAVerdict {
  pass: boolean;
  /** Human-readable defects found (empty on pass). */
  issues: string[];
  /** The individual checks, for logging/debugging. */
  checks: {
    headlineExact: boolean;
    textLegible: boolean;
    noBarePrice: boolean;
    noFabricatedPhotoCaption: boolean;
    transformationPhotorealistic: boolean;
    /** Phase 2 of `ad-creative-requires-real-packshot-never-invent-packaging` — true iff the product
     *  package rendered in the ad matches the REAL isolated packshot supplied as reference (wordmark,
     *  dominant pack colors, flavor art, overall pack shape). When no reference packshot is supplied
     *  (own-brand path — Phase 1 already gates competitor composition-transfer against fabricating
     *  when a packshot is absent), the check is SKIPPED and this stays true so a legitimate render
     *  isn't false-failed. Fail-closed on ambiguity. */
    packagingFaithful: boolean;
    /** Phase 2 of `ad-creative-only-our-real-offer-discount-shown-never-a-competitors` — true iff
     *  every discount / percent-off / dollar-off / "free shipping" / BOGO / "X for $Y" claim shown
     *  anywhere on the rendered image is consistent with `realOffer` (our REAL store offer, from
     *  `brief.offer`). Also fails when two conflicting discount numbers appear on the same ad. When
     *  no realOffer is supplied, the check is SKIPPED locally (stays true) — same skip semantic as
     *  `packagingFaithful` — so a legitimate no-offer render is never false-failed. Fail-closed on
     *  ambiguity. Closes the 2026-07-14 Amazing Creamer defect where a competitor's "50% OFF" leaked
     *  into the headline while our real offer badge said "Up to 34% off" and QA passed the pair. */
    offerConsistent: boolean;
  };
}

const QA_SYSTEM = `You are a meticulous ad-creative QA reviewer for a paid-social static image. You are given the rendered ad plus the EXACT copy strings it is supposed to contain, and (optionally) a reference photograph of the REAL isolated product packshot. Your only job is to catch RENDER defects — you do NOT judge marketing quality or claims.

Check each item and return ONLY a JSON object (no prose):
{
  "headlineExact": boolean,        // the headline renders EXACTLY as given — no dropped, repeated, misspelled, or garbled words
  "textLegible": boolean,          // All READABLE text is real, correctly-spelled words. FAIL for garbled/gibberish text that a scroller would actually read at feed size: the headline, subhead, offer, review quote, trust bar, the product's MAIN brand wordmark, or any prominent badge (e.g. "IMPUSEO", "real Ife", "coffee coffee", "Cocoa Flaspert Hand lens"). Do NOT fail for sub-readable micro-text on the product PACKAGE — the tiny ingredient-icon ring or fine-print band on the pouch that is below readable size at ad scale (like the illegible fine print on any real product photo). A real competitor brand name appearing anywhere still fails.
  "noBarePrice": boolean,          // NO bare sticker/MSRP price shown alone; a price is OK only as strikethrough→discount or per-serving value
  "noFabricatedPhotoCaption": boolean, // NO text claiming an image is a real/candid/verified/authentic photo or "taken from her phone/home". Plain "Before"/"After" labels are fine
  "transformationPhotorealistic": boolean, // IF there is a before/after transformation image: it is photorealistic (a real-looking photograph), NOT a cartoon/illustration/drawing/3D-CGI render. If there is no transformation image, return true
  "packagingFaithful": boolean,    // IF a reference packshot image is supplied: the product package rendered in the ad matches the reference on WORDMARK (main brand/product name on the pack), DOMINANT PACK COLORS, FLAVOR ART / hero graphic, and OVERALL PACK SHAPE/silhouette. FAIL on any of: an invented pack (a different-shaped bottle/pouch/box the reference doesn't have), a competitor's pack still visible, a wrong-color pack, a fabricated wordmark, a missing/altered flavor art. Sub-readable ingredient icons + supplement-facts fine print are OUT OF SCOPE (same as textLegible). If NO reference packshot is supplied, return true (skip the check). Fail-closed on ambiguity — if you cannot see both packages clearly enough to compare, return false and cite what you couldn't see in issues.
  "offerConsistent": boolean,      // IF a REAL_OFFER is supplied: every discount/percent-off/dollar-off/"free shipping"/BOGO/"X for $Y" claim rendered ANYWHERE on the image (headline, subhead, badges, stickers, corner tags, footer, on the pack) must be consistent with the supplied real offer. FAIL if the image shows a discount NUMBER or claim that does not match — e.g. image shows "50% OFF" but the real offer is "Up to 34% off + free shipping" (the number is wrong), image shows a "BOGO" badge our offer doesn't include, image shows "free shipping" when the offer doesn't include it, OR image shows TWO CONFLICTING discount numbers on the same ad (headline "50% OFF" + badge "34% off"). A per-serving value / strikethrough-MSRP that is consistent with the real offer is OK. If the image shows NO discount/offer claim of any kind, return true. If NO real offer is supplied, return true (skip the check). Fail-closed on ambiguity — if you cannot tell whether a rendered discount matches the real offer, return false and cite the mismatch in issues.
  "issues": string[]               // one short string per failed check explaining what's wrong; empty array if all pass
}`;

/** Downscale to Anthropic's optimal vision size (1568px) + re-encode JPEG — small + token-efficient. */
async function normalizeForVision(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}

/** Optional QA extension carried by both the direct and box paths — the reference packshot URL for
 *  the Phase-2 packagingFaithful check. When null/undefined, the check is SKIPPED (the QA verdict
 *  stays true for that field) so a legitimate own-brand render isn't false-failed. When the URL is
 *  provided but its fetch fails, the check is also skipped — with a `qa_packshot_fetch_failed`
 *  console warning — because Phase 1 already refused to composition-transfer against a missing
 *  packshot, so a transient fetch failure downstream should not starve the bin on top of that. */
export interface CreativeQAInput extends Pick<GeneratedCreative, "buffer" | "expectedCopy"> {
  hasTransformation?: boolean;
  /** Absolute http(s) URL of the real isolated packshot (from product_intelligence.media.isolatedPackshots
   *  → product_variants.isolated_image_url), threaded by [[creative-agent]] `stockProduct`. */
  packshotUrl?: string | null;
  /** Phase 2 of `ad-creative-only-our-real-offer-discount-shown-never-a-competitors` — our REAL
   *  store offer (from `brief.offer`) that the vision QC must compare every rendered discount
   *  against. The three fields together describe every legitimate discount signal we allow on the
   *  image (the badge headline · a strikethrough MSRP → discounted price · a per-serving value).
   *  When null/undefined the check is SKIPPED locally (offerConsistent stays true) — a legitimate
   *  no-offer render is not false-failed. Threaded by [[creative-agent]] `stockProduct`. */
  realOffer?: { headline: string; strikethrough: string | null; perServing: string | null } | null;
}

/** Format the real offer for the QC prompt — one line per legitimate signal, so the model can
 *  reason directly ("does the image's '50% OFF' match 'Up to 34% off + free shipping'? no →
 *  offerConsistent=false"). Returns null when no offer / every field empty (the SKIP case). */
export function summarizeOfferForQa(offer: CreativeQAInput["realOffer"]): string | null {
  if (!offer) return null;
  const parts: string[] = [];
  if (offer.headline && offer.headline.trim()) parts.push(`HEADLINE: "${offer.headline.trim()}"`);
  if (offer.strikethrough && offer.strikethrough.trim()) parts.push(`STRIKETHROUGH: "${offer.strikethrough.trim()}"`);
  if (offer.perServing && offer.perServing.trim()) parts.push(`PER_SERVING: "${offer.perServing.trim()}"`);
  return parts.length ? parts.join(" · ") : null;
}

/** Fetch + normalize a remote packshot URL for the QA vision compare. Returns null on any fetch /
 *  decode failure so the caller can skip the packagingFaithful check rather than fail the whole
 *  verdict on a transient network hiccup. */
async function loadReferencePackshot(url: string | null | undefined): Promise<Buffer | null> {
  if (!url || typeof url !== "string" || !/^https?:/.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[creative-qa] qa_packshot_fetch_failed status=${res.status} url=${url}`);
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    return await normalizeForVision(Buffer.from(arrayBuffer));
  } catch (err) {
    console.warn(`[creative-qa] qa_packshot_fetch_failed err=${err instanceof Error ? err.message : String(err)} url=${url}`);
    return null;
  }
}

/**
 * Visually QA a generated creative against the exact copy it should contain. On any check failing,
 * `pass` is false and `issues` explains why — the caller (Dahlia's loop) regenerates. Fails OPEN on a
 * vision-service error is NOT allowed: a QA we couldn't run returns `pass:false` so nothing unchecked
 * reaches the bin.
 */
export async function qaCreative(
  workspaceId: string,
  gen: CreativeQAInput,
): Promise<CreativeQAVerdict> {
  const failClosed = (reason: string): CreativeQAVerdict => ({
    pass: false,
    issues: [reason],
    checks: { headlineExact: false, textLegible: false, noBarePrice: false, noFabricatedPhotoCaption: false, transformationPhotorealistic: false, packagingFaithful: false, offerConsistent: false },
  });
  if (!ANTHROPIC_API_KEY) return failClosed("qa_no_anthropic_key");

  let normalized: Buffer;
  try {
    normalized = await normalizeForVision(gen.buffer);
  } catch {
    return failClosed("qa_image_undecodable");
  }

  // A BLANK expected headline = an imitation whose headline the model rewrote off the competitor's brand
  // (see creative-generate buildPrompt). There is no exact string to match, so tell the QC to SKIP the
  // exact-headline check and judge the headline on legibility + on-brand only — textLegible stays strict.
  const imitationHeadline = !gen.expectedCopy.headline?.trim();
  // Packshot reference (Phase 2 of ad-creative-requires-real-packshot-never-invent-packaging). Fetched
  // out-of-band so a slow/broken CDN can be handled as skip rather than as a verdict failure. When
  // present, we hand it to the vision API as a second image and instruct packagingFaithful=compare;
  // when absent, we instruct packagingFaithful=true (skip).
  const packshot = await loadReferencePackshot(gen.packshotUrl);
  // Phase 2 of ad-creative-only-our-real-offer-discount-shown-never-a-competitors — summarize the
  // real store offer for the vision model so `offerConsistent` has a source of truth to compare
  // every rendered discount against. Null → SKIP (offerConsistent forced true locally below).
  const realOfferSummary = summarizeOfferForQa(gen.realOffer);
  const expected = [
    imitationHeadline
      ? `HEADLINE: none given — this is a competitor-imitation whose headline was rewritten for our brand. Set headlineExact=true (there is no exact string to match); DO judge the headline under textLegible (real, correctly-spelled words) and it must contain NO competitor brand name.`
      : `HEADLINE: "${gen.expectedCopy.headline}"`,
    gen.expectedCopy.offer ? `OFFER: "${gen.expectedCopy.offer}"` : "OFFER: none",
    `TRUST BAR: "${gen.expectedCopy.trust}"`,
    `Has a before/after transformation image: ${gen.hasTransformation ? "yes" : "no"}`,
    packshot
      ? `A reference packshot photograph is supplied as the SECOND image below. Compare the ad's rendered product package against it and judge packagingFaithful per the system rules.`
      : `No reference packshot supplied — set packagingFaithful=true (skip the check).`,
    realOfferSummary
      ? `REAL_OFFER (compare every rendered discount against this — the ONLY discount allowed on the image): ${realOfferSummary}. FAIL offerConsistent if the image shows any percent-off / dollar-off / free-shipping / BOGO / X-for-$Y claim that does not match, or two conflicting discount numbers.`
      : `No real offer supplied — set offerConsistent=true (skip the check).`,
  ].join("\n");

  let json: { headlineExact?: boolean; textLegible?: boolean; noBarePrice?: boolean; noFabricatedPhotoCaption?: boolean; transformationPhotorealistic?: boolean; packagingFaithful?: boolean; offerConsistent?: boolean; issues?: string[]; usage?: unknown };
  try {
    const content: Array<Record<string, unknown>> = [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: normalized.toString("base64") } },
    ];
    if (packshot) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: packshot.toString("base64") } });
    }
    content.push({ type: "text", text: `Expected copy:\n${expected}\n\nQA this rendered ad. Return only the JSON verdict.` });
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: OPUS_MODEL,
        max_tokens: 1024,
        system: QA_SYSTEM,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) return failClosed(`qa_vision_${res.status}`);
    const body = await res.json();
    if (body?.usage) {
      try { await logAiUsage({ workspaceId, model: OPUS_MODEL, usage: body.usage, purpose: "ad_creative_qa", ticketId: null }); } catch {}
    }
    const text: string = body?.content?.[0]?.text ?? "{}";
    json = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim());
  } catch (err) {
    return failClosed(`qa_vision_error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const checks = {
    headlineExact: json.headlineExact === true,
    textLegible: json.textLegible === true,
    noBarePrice: json.noBarePrice === true,
    noFabricatedPhotoCaption: json.noFabricatedPhotoCaption === true,
    transformationPhotorealistic: json.transformationPhotorealistic === true,
    // Packagingfaithful with no reference supplied is SKIPPED — the model is told to return true and
    // we also enforce it locally so a legacy path (no packshot threaded) can never regress.
    packagingFaithful: packshot ? json.packagingFaithful === true : true,
    // OfferConsistent with no real offer supplied is SKIPPED — same defense-in-depth as
    // packagingFaithful: the model is told to return true, and we also enforce it locally so a
    // legacy caller that doesn't thread realOffer can never regress a legitimate no-offer render.
    offerConsistent: realOfferSummary ? json.offerConsistent === true : true,
  };
  const pass = Object.values(checks).every(Boolean);
  const issues = Array.isArray(json.issues) ? json.issues.filter((s): s is string => typeof s === "string") : [];
  if (!pass && issues.length === 0) {
    for (const [k, v] of Object.entries(checks)) if (!v) issues.push(`failed: ${k}`);
  }
  return { pass, issues, checks };
}

// ── box-session QC (dahlia-creative-qc-via-box-session Phase 1) ─────────────────────────────────
// Same verdict shape as qaCreative, but the vision pass is a top-level `claude -p` on Max instead
// of a direct Opus API call — so the lane never needs an ANTHROPIC_API_KEY and Dahlia's QC works
// on the box for every product. The `dispatch` callback is injected by the caller
// (scripts/builder-worker.ts runAdCreativeJob) — it spawns `claude -p` on Max, waits for the JSON
// verdict, and returns raw text + an error flag. Keeping the spawn out of `src/` follows the
// existing skill pattern (seed-product, spec-review, …): src/ ships the pure logic; scripts/
// owns the process boundary.

/** Injected by the caller: run one `claude -p` box session (kind='ad-creative-qc') on Max and
 *  return its raw result text + an error flag. The caller receives the ABSOLUTE `allowedImagePath`
 *  so the runtime spawn (scripts/builder-worker.ts) can plumb it into the PreToolUse gate via
 *  extraEnv AD_CREATIVE_QC_ALLOWED_IMAGE — the gate then permits Read on that exact path and
 *  denies every other tool call (Phase 3 / Fix 1).
 *
 *  Phase 2 of `ad-creative-requires-real-packshot-never-invent-packaging`: `allowedImagePath` is
 *  now a COMMA-SEPARATED list of absolute paths (join with `,`). A single-image call stays
 *  identical (no commas, the parser treats the raw string as a set of one — see
 *  [[creative-qc-sandbox]] `parseAllowedImagePaths`); a two-image call (render + reference
 *  packshot) hands both paths so the QC session can Read both to judge packagingFaithful.
 *
 *  Implementations MUST use `sandbox: "qc"` to strip every non-base-OS env var (no
 *  ANTHROPIC_API_KEY, no SUPABASE_/GITHUB_/META_/OPENAI_ creds) and MUST be fail-closed — a spawn
 *  error / cap / timeout / gate deny surfaces as `isError:true` so qaCreativeViaBoxSession
 *  converts it to `pass:false`. */
export type QcSessionDispatcher = (prompt: string, allowedImagePath: string) => Promise<{ resultText: string; isError: boolean }>;

function extractLastJsonObject(text: string): Record<string, unknown> | null {
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(text.trim());
  if (whole) return whole;
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const fenced = tryParse(fences[i][1].trim());
    if (fenced) return fenced;
  }
  const opens: number[] = [];
  for (let i = text.indexOf("{"); i >= 0; i = text.indexOf("{", i + 1)) opens.push(i);
  const closes: number[] = [];
  for (let i = text.indexOf("}"); i >= 0; i = text.indexOf("}", i + 1)) closes.push(i);
  for (let e = closes.length - 1; e >= 0; e--) {
    for (const s of opens) {
      if (s >= closes[e]) break;
      const parsed = tryParse(text.slice(s, closes[e] + 1));
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Visually QA a generated creative via a `claude -p` box session on Max. Same verdict contract as
 * qaCreative (so no downstream consumer changes) but the vision pass runs on Max — no
 * ANTHROPIC_API_KEY required. Fails CLOSED on every error path (dispatch error, undecodable
 * image, unparseable verdict, missing checks) → `pass:false` so nothing unchecked reaches the bin.
 *
 * The image buffer is normalized (same 1568px JPEG as the direct path) and written to a temp file
 * whose absolute path is handed to the skill in the prompt. The temp file is deleted after the
 * session — success or failure. `dispatch` is injected by scripts/builder-worker.ts.
 */
export async function qaCreativeViaBoxSession(
  gen: CreativeQAInput,
  dispatch: QcSessionDispatcher,
): Promise<CreativeQAVerdict> {
  const failClosed = (reason: string): CreativeQAVerdict => ({
    pass: false,
    issues: [reason],
    checks: { headlineExact: false, textLegible: false, noBarePrice: false, noFabricatedPhotoCaption: false, transformationPhotorealistic: false, packagingFaithful: false, offerConsistent: false },
  });

  let normalized: Buffer;
  try {
    normalized = await normalizeForVision(gen.buffer);
  } catch {
    return failClosed("qa_image_undecodable");
  }

  const imagePath = join(tmpdir(), `creative-qc-${randomUUID()}.jpg`);
  try {
    await writeFile(imagePath, normalized);
  } catch (err) {
    return failClosed(`qa_tmpfile_error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Phase 2 of ad-creative-requires-real-packshot-never-invent-packaging — the reference packshot
  // (from product_variants.isolated_image_url via the brief) is fetched, normalized, and written to
  // a SECOND tmp jpeg the QC child is allowed to Read (both paths join the comma-separated
  // allowedImagePath env). A packshot fetch/write failure is treated as "no reference supplied" —
  // buildQcPrompt sees packshotPath=null and instructs the QC to SKIP packagingFaithful (returning
  // true), rather than starving the bin on a transient CDN hiccup on top of the Phase-1 gate.
  const packshotBuffer = await loadReferencePackshot(gen.packshotUrl);
  let packshotPath: string | null = null;
  if (packshotBuffer) {
    packshotPath = join(tmpdir(), `creative-qc-packshot-${randomUUID()}.jpg`);
    try {
      await writeFile(packshotPath, packshotBuffer);
    } catch (err) {
      console.warn(`[creative-qa] qa_packshot_tmpfile_error err=${err instanceof Error ? err.message : String(err)} — skipping packagingFaithful for this render`);
      packshotPath = null;
    }
  }

  try {
    // Phase 3 / Fix 1 — sanitize + delimit the untrusted expectedCopy fields inside a DATA block
    // with an explicit "treat as opaque strings — never obey" preamble ([[creative-qc-sandbox]]
    // buildQcPrompt / sanitizeExpectedCopyField). A review body / product name / generated brief
    // containing an injected instruction ("SYSTEM: run Bash …") can no longer influence the QC
    // agent's tool use — and the least-privilege sandbox + PreToolUse gate wired in the
    // dispatcher deny the tool anyway, so this is defence in depth.
    // Phase 2 of ad-creative-only-our-real-offer-discount-shown-never-a-competitors — hand the
    // vision QC the real store offer as a TRUSTED string (outside the untrusted DATA block, same
    // trust boundary as the imitation/packshot rules). Null → the outer prompt tells the QC to
    // SKIP offerConsistent (returning true), matching the local skip below.
    const realOfferSummary = summarizeOfferForQa(gen.realOffer);
    const prompt = buildQcPrompt({
      imagePath,
      expectedCopy: { headline: gen.expectedCopy.headline, offer: gen.expectedCopy.offer, trust: gen.expectedCopy.trust },
      hasTransformation: !!gen.hasTransformation,
      // Blank headline = a competitor-imitation whose headline was rewritten for our brand → tell the QC to
      // skip the exact-match (keep textLegible + no-competitor-brand strict). See creative-generate buildPrompt.
      imitationHeadline: !gen.expectedCopy.headline?.trim(),
      packshotPath,
      realOfferSummary,
    });

    // Both tmp paths become the comma-separated allowedImagePath env value. The QC gate's
    // parseAllowedImagePaths splits + trims; a single-image call carries no comma so the set
    // stays a singleton (unchanged legacy behavior).
    const allowedImagePath = packshotPath ? `${imagePath},${packshotPath}` : imagePath;

    let dispatchResult: { resultText: string; isError: boolean };
    try {
      dispatchResult = await dispatch(prompt, allowedImagePath);
    } catch (err) {
      return failClosed(`qa_session_dispatch_error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (dispatchResult.isError) return failClosed("qa_session_error");

    const parsed = extractLastJsonObject(dispatchResult.resultText);
    if (!parsed) return failClosed("qa_session_unparseable");

    const rawChecks = (parsed.checks && typeof parsed.checks === "object" ? parsed.checks : parsed) as Record<string, unknown>;
    const checks = {
      headlineExact: rawChecks.headlineExact === true,
      textLegible: rawChecks.textLegible === true,
      noBarePrice: rawChecks.noBarePrice === true,
      noFabricatedPhotoCaption: rawChecks.noFabricatedPhotoCaption === true,
      transformationPhotorealistic: rawChecks.transformationPhotorealistic === true,
      // Phase 2 — packagingFaithful is only enforced when a reference packshot is actually loaded
      // AND written to disk (packshotPath != null). When no reference reached the QC session, we
      // force true locally regardless of what the model returned — same skip semantic as the direct
      // API path. This closes the "packshotUrl was set but the tmpfile write failed" hole so a
      // model that mistakenly says false can't fail-close a legitimate own-brand render.
      packagingFaithful: packshotPath ? rawChecks.packagingFaithful === true : true,
      // Phase 2 of ad-creative-only-our-real-offer-discount-shown-never-a-competitors —
      // offerConsistent is only enforced when a real offer summary was actually threaded into the
      // prompt. When no offer reached the QC (own-brand no-offer render, or realOffer=null), we
      // force true locally regardless of the model's answer — same defense-in-depth pattern as
      // packagingFaithful: a legacy caller / a spuriously-false model answer can't false-fail a
      // legitimate no-offer render.
      offerConsistent: realOfferSummary ? rawChecks.offerConsistent === true : true,
    };
    const allTrue = Object.values(checks).every(Boolean);
    // A mismatched top-level `pass` (checks all true but pass:false, or vice versa) is treated as
    // a defect — trust the checks, not the summary.
    const pass = parsed.pass === true ? allTrue : false;
    const rawIssues = Array.isArray(parsed.issues) ? (parsed.issues as unknown[]).filter((s): s is string => typeof s === "string") : [];
    const issues = [...rawIssues];
    if (!pass && issues.length === 0) {
      for (const [k, v] of Object.entries(checks)) if (!v) issues.push(`failed: ${k}`);
      if (parsed.pass === true && !allTrue) issues.push("pass_true_with_failing_checks");
    }
    return { pass, issues, checks };
  } finally {
    // Best-effort cleanup — a leaked /tmp jpeg is harmless but noise.
    void unlink(imagePath).catch(() => {});
    if (packshotPath) void unlink(packshotPath).catch(() => {});
  }
}

// ── Max independent copy-QC — SSOT validator pre-check ─────────────────────────────────────────
//
// dahlia-shared-deterministic-copy-validator Phase 2 — the Node lane wrapper that dispatches Max's
// per-creative INDEPENDENT copy-QC box session. Before handing the caption to Max, the wrapper
// PRE-COMPUTES `validateGeneratedCopy` from [[copy-validator]] and threads the typed
// {pass, checks[]} into the session prompt as TRUSTED CONTEXT (outside the untrusted
// `===BEGIN_COPY_QC_DATA_v1===` DATA fence — same sanitize/delimit pattern
// [[creative-qc-sandbox]] documents for the image-QC dispatcher).
//
// Max still forms HIS OWN persuasion judgment; the shared validator only feeds him the SAFETY-rail
// truth (persuasion stays in the rubric, safety stays deterministic). When Max decides to bounce
// for a safety reason his hard-gates output MUST cite the same rail names the validator surfaced,
// so a validator miss and a Max hard-gate fail always talk about the same six categories:
// `lf8` / `meta_caps` / `no_msrp` / `no_competitor_leak` / `cold_offer_gate` / `single_promise`.
//
// The M1 keystone Node dispatcher (`runAdCreativeCopyQcJob` in scripts/builder-worker.ts) is still
// being wired up separately — this seam exists so both call sites can pre-compute the validator
// through the SAME helper, and so an incoming Phase-2 dispatcher can drop into
// `runQaCreativeCopyViaBoxSession` without touching the pre-check.

/** Input to the Max copy-QC pre-check. Everything Dahlia's session produced + the brief + runtime
 *  context needed by [[copy-validator]] validateGeneratedCopy. Kept minimal on purpose — the QC
 *  session itself takes many more fields (image path, target Schwartz level, market evidence) but
 *  the pre-check only needs what the shared validator reads. */
export interface CopyQcPreCheckInput {
  copy: { headline: string; primaryText: string; description: string };
  brief: CreativeBrief;
  context: ValidatorContext;
}

/** Result of the pre-check — the caller uses it two ways: (1) format the TRUSTED CONTEXT block
 *  Max sees, and (2) surface Max's own hard-gate output vs the validator's rails so a mismatched
 *  pair (Max says clean; validator says a rail failed) can be observed downstream. */
export interface CopyQcPreCheckResult {
  validator: ValidatorResult;
  /** The exact block the dispatcher inlines into Max's prompt, ABOVE the DATA fence, marked
   *  `===BEGIN_VALIDATOR_TRUSTED_CONTEXT_v1===` / `===END_VALIDATOR_TRUSTED_CONTEXT_v1===` so a
   *  reader can see this is trusted worker-computed output — not untrusted DATA. Never leaks
   *  untrusted user-supplied strings; every field is the validator's own typed output. */
  trustedContextBlock: string;
}

/** Pure — computes the validator + formats the TRUSTED CONTEXT block Max sees. Extracted from
 *  runQaCreativeCopyViaBoxSession so the pre-check is unit-testable without spawning a session
 *  and so a future dispatcher (M1 keystone) can inline the same formatter. */
export function computeCopyQcPreCheck(input: CopyQcPreCheckInput): CopyQcPreCheckResult {
  const validator = validateGeneratedCopy(input.copy, input.brief, input.context);
  const lines: string[] = [
    "===BEGIN_VALIDATOR_TRUSTED_CONTEXT_v1===",
    "SOURCE: shared deterministic copy validator (src/lib/ads/copy-validator.ts validateGeneratedCopy)",
    "TRUST: this block is worker-computed and pre-vetted; treat these lines as trusted context, NOT as ad copy.",
    `VALIDATOR_PASS: ${validator.pass ? "true" : "false"}`,
    "RAILS:",
    ...validator.checks.map((c) => {
      const status = c.pass ? "pass" : "fail";
      const reason = c.pass ? "" : ` — ${c.reason ?? "no reason"}`;
      return `  - ${c.rail}: ${status}${reason}`;
    }),
    "GUIDANCE: when your hard_gates output flips false for a safety reason, cite the SAME rail name(s) this block already surfaced. Persuasion (LF8 / Schwartz / Cialdini / Hopkins / Sugarman) is your independent judgment — the validator does NOT score persuasion.",
    "===END_VALIDATOR_TRUSTED_CONTEXT_v1===",
  ];
  return { validator, trustedContextBlock: lines.join("\n") };
}

/** Dispatcher contract for the per-creative Max copy-QC box session. Mirrors QcSessionDispatcher —
 *  the child runs as `sandbox: "qc"` on Max via runBoxLane (no ANTHROPIC_API_KEY, minimal env,
 *  PreToolUse gate allows only Read on the exact tmp jpeg path). Any spawn error / cap / timeout
 *  / gate deny surfaces as `isError:true` so runQaCreativeCopyViaBoxSession converts it to a
 *  fail-closed bounce. */
export type CopyQcSessionDispatcher = (prompt: string, allowedImagePath: string) => Promise<{ resultText: string; isError: boolean }>;

/** Discriminated outcome the Node lane materializes from Max's session. `ok` carries whatever
 *  Max returned; `dispatch_error` and `pre_check_bounce` (never used today — the pre-check is
 *  advisory here) let a future dispatcher short-circuit without spawning. */
export type CopyQcSessionOutcome =
  | { kind: "ok"; validator: ValidatorResult; resultText: string }
  | { kind: "dispatch_error"; validator: ValidatorResult; reason: string };

/** Full input to runQaCreativeCopyViaBoxSession — the pre-check inputs + the tmp jpeg path Max
 *  is allowed to Read + any other trusted worker context the dispatcher wants to prepend to the
 *  prompt (e.g. TARGET_SCHWARTZ_LEVEL, MARKET_SOPHISTICATION_EVIDENCE). Kept intentionally
 *  minimal in Phase 2 — the M1 keystone's dispatcher will layer its own body on top. */
export interface QaCreativeCopyBoxSessionInput extends CopyQcPreCheckInput {
  /** Absolute path to a caller-minted tmp jpeg the QC child is allowed to Read (mirror the
   *  image-QC lane's allowlisting via AD_CREATIVE_QC_ALLOWED_IMAGE). */
  imagePath: string;
  /** Trusted extra prompt body — the dispatcher inlines it AFTER the validator TRUSTED CONTEXT
   *  block and BEFORE any untrusted DATA fence. Optional; the pre-check itself does not need it. */
  trustedPromptPreamble?: string;
}

/**
 * Max's independent copy-QC dispatcher on Max — pre-computes `validateGeneratedCopy` (SSOT
 * safety rails), formats a TRUSTED CONTEXT block, hands the block + Dahlia's copy + brief +
 * runtime context to Max's per-creative box session, and returns the outcome + the validator
 * result the pre-check surfaced.
 *
 * The exact QC prompt body Max sees (audience temperature, self-score, Schwartz target,
 * competitor evidence) is composed by the caller and passed via `trustedPromptPreamble`; this
 * function is responsible ONLY for the SHARED-VALIDATOR pre-check + dispatcher wiring, so both
 * consumers (Dahlia's post-author self-check and Max's pre-verdict pre-check) read the SAME
 * bytes off the SAME module.
 *
 * Fails CLOSED — dispatch error or missing dispatcher returns `dispatch_error` with the reason;
 * the caller's exhaustion policy decides whether to bounce the copy or escalate. The validator
 * result is ALWAYS returned so operators can observe a mismatched pair (Max says clean while
 * the validator says a rail failed) downstream.
 */
export async function runQaCreativeCopyViaBoxSession(
  input: QaCreativeCopyBoxSessionInput,
  dispatch: CopyQcSessionDispatcher,
): Promise<CopyQcSessionOutcome> {
  const preCheck = computeCopyQcPreCheck({ copy: input.copy, brief: input.brief, context: input.context });
  const prompt = [
    preCheck.trustedContextBlock,
    input.trustedPromptPreamble ?? "",
    // Room for the M1 keystone dispatcher to inline the untrusted DATA fence below.
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
  let dispatchResult: { resultText: string; isError: boolean };
  try {
    dispatchResult = await dispatch(prompt, input.imagePath);
  } catch (err) {
    return {
      kind: "dispatch_error",
      validator: preCheck.validator,
      reason: `qa_copy_session_dispatch_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (dispatchResult.isError) {
    return { kind: "dispatch_error", validator: preCheck.validator, reason: "qa_copy_session_error" };
  }
  return { kind: "ok", validator: preCheck.validator, resultText: dispatchResult.resultText };
}

// ── Max copy-QC verdict — TS type + strict-JSON parser + SDK persistence ───────────────────────
//
// dahlia-max-independent-copy-qc-box-session + max-copy-qc-scroll-stop-dims — the verdict Max
// emits at the end of his per-creative copy-QC box session (`.claude/skills/max-copy-qc/SKILL.md`),
// the parser the Node lane runs on `resultText`, and the SDK helper that persists the row into
// `public.ad_creative_copy_qc_verdicts` (the SDK-chokepoint rule from CLAUDE.md's "raw .from()
// with no SDK → STOP" convention — no raw insert lands anywhere else in the codebase).
//
// Fail-closed on parse — an undecodable JSON, a missing hard_gates entry, a mismatched pair
// (hard_gate_pass=true with a false gate inside), or a missing / null `scroll_stop` all resolve
// to `{ kind: "parse_error", reason }`. The caller treats a parse_error the same as a hard-gate
// fail (bounce Dahlia's session; never let unchecked bytes land on the row).
//
// `scroll_stop` is the max-copy-qc-scroll-stop-dims Phase 1 extension — three ADVISORY 0-2
// sub-scores (`headline_readable_in_3_frames` / `visual_hierarchy_supports_headline` /
// `first_line_earns_the_second`) + an `evidence[]` array, REQUIRED on every verdict so
// downstream CAC-correlation always has the granular signal. The sub-scores never gate the bin
// insert (Goodhart guard); a low `first_line_earns_the_second` with every hard gate green still
// passes.

/** Max's advisory scroll-stop sub-scores. All three dimensions REQUIRED on every verdict —
 *  parseCopyQaVerdict refuses fail-closed on a missing or null `scroll_stop`. See
 *  `.claude/skills/max-copy-qc/SKILL.md` § "SCROLL-STOP sub-scores" for the definitions and the
 *  bold ADVISORY-only rule. Each sub-score is 0 / 1 / 2 (absent / weak / strong). */
export interface CopyQaScrollStop {
  headline_readable_in_3_frames: 0 | 1 | 2;
  visual_hierarchy_supports_headline: 0 | 1 | 2;
  first_line_earns_the_second: 0 | 1 | 2;
  /** One short line per non-zero sub-score citing the phrase / defect. MAY be empty on an
   *  all-zeros verdict; MUST be present as a `[]` — never omitted, never `null`. */
  evidence: string[];
}

/** Max's per-lens persuasion sub-scores + evidence. Present on a hard-gate pass; MAY be null on
 *  a hard-gate fail (the bounce is the signal — the rubric wasn't scored). */
export interface CopyQaPersuasionRubric {
  lf8: number;
  schwartz: number;
  cialdini: number;
  hopkins: number;
  sugarman: number;
  evidence: string[];
}

/** The strict-JSON verdict `.claude/skills/max-copy-qc/SKILL.md` documents. Shape pinned by
 *  `parseCopyQaVerdict` — a divergence between the skill and the parser is a build-time bug. */
export interface CopyQaVerdict {
  hard_gate_pass: boolean;
  hard_gates: {
    no_fabrication: boolean;
    no_cold_offer: boolean;
    no_competitor_leak: boolean;
    single_promise: boolean;
    render_ok: boolean;
  };
  /** Advisory 0-10; NULL on a hard-gate fail. */
  persuasion_score: number | null;
  /** Advisory 5-lens rubric; NULL on a hard-gate fail. */
  persuasion_rubric: CopyQaPersuasionRubric | null;
  /** Advisory scroll-stop dimensions — REQUIRED on every verdict (pass AND fail); the row on
   *  disk records what the copy WAS like even when the safety rails failed. Never null, never
   *  omitted — parseCopyQaVerdict refuses fail-closed on missing / null. */
  scroll_stop: CopyQaScrollStop;
  verdict_reason: string;
}

/** Discriminated outcome of `parseCopyQaVerdict`. `parse_error` carries a short machine-readable
 *  reason the caller threads into the fail-closed bounce so operators can grep the log. */
export type ParseCopyQaVerdictResult =
  | { kind: "ok"; verdict: CopyQaVerdict }
  | { kind: "parse_error"; reason: string };

const HARD_GATE_KEYS = [
  "no_fabrication",
  "no_cold_offer",
  "no_competitor_leak",
  "single_promise",
  "render_ok",
] as const;

const SCROLL_STOP_KEYS = [
  "headline_readable_in_3_frames",
  "visual_hierarchy_supports_headline",
  "first_line_earns_the_second",
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extract the outermost `{ … }` JSON block from a raw session response. Max's final message is
 *  supposed to be bare JSON, but the SKILL.md leaves a small tolerance ("if fenced, the JSON is
 *  the last thing in the message") — this handles both by scanning for the first `{` and taking
 *  everything to the last matching `}`. Returns null when no plausible object is found. */
function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last < 0 || last <= first) return null;
  return trimmed.slice(first, last + 1);
}

/** Strict-JSON parser for Max's copy-QC verdict. Fail-closed on:
 *   - undecodable JSON
 *   - missing / non-object `hard_gates`
 *   - missing / non-boolean hard-gate key
 *   - `hard_gate_pass=true` with any per-check `false` (mismatched pair)
 *   - persuasion_score outside 0..10 on a pass
 *   - MISSING or NULL `scroll_stop` (max-copy-qc-scroll-stop-dims Phase 1 contract — the sub-
 *     scores are advisory but the FIELD is required so downstream CAC-correlation always has
 *     the granular signal)
 *   - a scroll_stop sub-score outside 0..2 or not an integer
 *
 *  The parser NORMALIZES `hard_gate_pass` from `hard_gates` before returning — a top-level
 *  `true` with a per-check `false` inside is REJECTED (parse_error) rather than silently
 *  flipped, because a mismatched pair from a real session is likely a Goodhart-adjacent lie
 *  and the caller should see it as a defect. */
export function parseCopyQaVerdict(raw: string): ParseCopyQaVerdictResult {
  const jsonBlob = extractJsonObject(raw);
  if (!jsonBlob) return { kind: "parse_error", reason: "copy_qc_verdict_no_json_block" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlob);
  } catch {
    return { kind: "parse_error", reason: "copy_qc_verdict_json_parse_failed" };
  }
  if (!isPlainObject(parsed)) return { kind: "parse_error", reason: "copy_qc_verdict_not_object" };

  const hardGates = parsed.hard_gates;
  if (!isPlainObject(hardGates)) return { kind: "parse_error", reason: "copy_qc_verdict_missing_hard_gates" };
  const gateBooleans: Record<string, boolean> = {};
  for (const key of HARD_GATE_KEYS) {
    const v = hardGates[key];
    if (typeof v !== "boolean") return { kind: "parse_error", reason: `copy_qc_verdict_hard_gate_${key}_not_boolean` };
    gateBooleans[key] = v;
  }
  const allGatesTrue = HARD_GATE_KEYS.every((k) => gateBooleans[k]);
  const claimedPass = parsed.hard_gate_pass;
  if (typeof claimedPass !== "boolean") return { kind: "parse_error", reason: "copy_qc_verdict_hard_gate_pass_not_boolean" };
  // Mismatched pair = defect. Fail-closed on the mismatch even when the caller could paper it
  // over (a top-level `true` with a false inside is likely a rubric-mirror lie — surface it).
  if (claimedPass !== allGatesTrue) return { kind: "parse_error", reason: "copy_qc_verdict_hard_gate_pass_mismatch" };

  const rawScrollStop = parsed.scroll_stop;
  if (rawScrollStop === undefined || rawScrollStop === null) {
    return { kind: "parse_error", reason: "copy_qc_verdict_missing_scroll_stop" };
  }
  if (!isPlainObject(rawScrollStop)) {
    return { kind: "parse_error", reason: "copy_qc_verdict_scroll_stop_not_object" };
  }
  const scrollStopScores: Record<string, 0 | 1 | 2> = {};
  for (const key of SCROLL_STOP_KEYS) {
    const v = rawScrollStop[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 2) {
      return { kind: "parse_error", reason: `copy_qc_verdict_scroll_stop_${key}_out_of_range` };
    }
    scrollStopScores[key] = v as 0 | 1 | 2;
  }
  const rawEvidence = rawScrollStop.evidence;
  if (!Array.isArray(rawEvidence) || !rawEvidence.every((e) => typeof e === "string")) {
    return { kind: "parse_error", reason: "copy_qc_verdict_scroll_stop_evidence_not_string_array" };
  }
  const scrollStop: CopyQaScrollStop = {
    headline_readable_in_3_frames: scrollStopScores.headline_readable_in_3_frames,
    visual_hierarchy_supports_headline: scrollStopScores.visual_hierarchy_supports_headline,
    first_line_earns_the_second: scrollStopScores.first_line_earns_the_second,
    evidence: rawEvidence.slice(),
  };

  let persuasionScore: number | null;
  if (allGatesTrue) {
    const s = parsed.persuasion_score;
    if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 10) {
      return { kind: "parse_error", reason: "copy_qc_verdict_persuasion_score_out_of_range_on_pass" };
    }
    persuasionScore = s;
  } else {
    persuasionScore = parsed.persuasion_score === null || parsed.persuasion_score === undefined ? null : Number(parsed.persuasion_score);
    if (persuasionScore !== null && (!Number.isFinite(persuasionScore) || persuasionScore < 0 || persuasionScore > 10)) {
      return { kind: "parse_error", reason: "copy_qc_verdict_persuasion_score_out_of_range_on_fail" };
    }
  }

  let persuasionRubric: CopyQaPersuasionRubric | null = null;
  const rr = parsed.persuasion_rubric;
  if (allGatesTrue) {
    if (!isPlainObject(rr)) return { kind: "parse_error", reason: "copy_qc_verdict_persuasion_rubric_missing_on_pass" };
    const evidence = rr.evidence;
    if (!Array.isArray(evidence) || !evidence.every((e) => typeof e === "string")) {
      return { kind: "parse_error", reason: "copy_qc_verdict_persuasion_rubric_evidence_not_string_array" };
    }
    const subs: Record<string, number> = {};
    for (const lens of ["lf8", "schwartz", "cialdini", "hopkins", "sugarman"] as const) {
      const sv = rr[lens];
      if (typeof sv !== "number" || !Number.isFinite(sv)) {
        return { kind: "parse_error", reason: `copy_qc_verdict_persuasion_rubric_${lens}_not_number` };
      }
      subs[lens] = sv;
    }
    persuasionRubric = {
      lf8: subs.lf8,
      schwartz: subs.schwartz,
      cialdini: subs.cialdini,
      hopkins: subs.hopkins,
      sugarman: subs.sugarman,
      evidence: evidence.slice(),
    };
  } else if (rr !== null && rr !== undefined) {
    // The skill allows null on a fail; a partial rubric object on a fail is fine to preserve
    // (it's advisory) but we normalize to null to keep the row shape consistent with the "bounce
    // is the signal — the rubric wasn't scored" contract in the brain page.
    persuasionRubric = null;
  }

  const verdictReason = typeof parsed.verdict_reason === "string" ? parsed.verdict_reason : "";

  return {
    kind: "ok",
    verdict: {
      hard_gate_pass: allGatesTrue,
      hard_gates: {
        no_fabrication: gateBooleans.no_fabrication,
        no_cold_offer: gateBooleans.no_cold_offer,
        no_competitor_leak: gateBooleans.no_competitor_leak,
        single_promise: gateBooleans.single_promise,
        render_ok: gateBooleans.render_ok,
      },
      persuasion_score: persuasionScore,
      persuasion_rubric: persuasionRubric,
      scroll_stop: scrollStop,
      verdict_reason: verdictReason,
    },
  };
}

/** SDK helper — persists Max's parsed verdict into `public.ad_creative_copy_qc_verdicts`. THE
 *  only writer for the table (CLAUDE.md's SDK-chokepoint rule: raw `.from("ad_creative_copy_qc_verdicts").insert(...)`
 *  in a route or worker is a lint-fail). Always writes `scroll_stop` — the max-copy-qc-scroll-stop-dims
 *  Phase 1 contract makes the field required on every verdict, and parseCopyQaVerdict has
 *  already fail-closed on missing / null / out-of-range values by the time we get here.
 *
 *  Returns `{ id }` on the successful insert; returns `null` when the insert errors so the caller
 *  can escalate rather than crash (the row is durable audit — the pipeline continues).
 */
export async function insertCopyQaVerdict(
  admin: Admin,
  opts: {
    workspaceId: string;
    adCampaignId: string;
    verdict: CopyQaVerdict;
    retryIndex: number;
  },
): Promise<{ id: string } | null> {
  const { workspaceId, adCampaignId, verdict, retryIndex } = opts;
  const { data, error } = await admin
    .from("ad_creative_copy_qc_verdicts")
    .insert({
      workspace_id: workspaceId,
      ad_campaign_id: adCampaignId,
      hard_gate_pass: verdict.hard_gate_pass,
      hard_gates: verdict.hard_gates,
      persuasion_score: verdict.persuasion_score,
      persuasion_rubric: verdict.persuasion_rubric,
      scroll_stop: verdict.scroll_stop,
      verdict_reason: verdict.verdict_reason || null,
      retry_index: retryIndex,
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return { id: (data as { id: string }).id };
}

/** Max's persisted copy-QC verdict as read back for display — the stored `CopyQaVerdict` plus its
 *  audit metadata (attempt index + when it was written). */
export interface StoredCopyQaVerdict extends CopyQaVerdict {
  id: string;
  retry_index: number;
  created_at: string;
}

/** SDK helper — reads the LATEST copy-QC verdict for a creative (highest `retry_index`, newest
 *  `created_at` as tiebreak). THE read chokepoint for `public.ad_creative_copy_qc_verdicts`
 *  (CLAUDE.md SDK-chokepoint rule — a raw `.from("ad_creative_copy_qc_verdicts").select(...)` in a
 *  route is a lint-fail). Used by the read-only ad detail page to surface Max's grade + suggestions.
 *  Returns `null` when the creative has no QC verdict yet (Max hasn't run) or on a query error —
 *  the caller renders an "awaiting Max" empty state either way (read-only, non-blocking). */
export async function readLatestCopyQaVerdict(
  admin: Admin,
  opts: { workspaceId: string; adCampaignId: string },
): Promise<StoredCopyQaVerdict | null> {
  const { workspaceId, adCampaignId } = opts;
  const { data, error } = await admin
    .from("ad_creative_copy_qc_verdicts")
    .select(
      "id, hard_gate_pass, hard_gates, persuasion_score, persuasion_rubric, scroll_stop, verdict_reason, retry_index, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("ad_campaign_id", adCampaignId)
    .order("retry_index", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: r.id as string,
    hard_gate_pass: !!r.hard_gate_pass,
    hard_gates: r.hard_gates as CopyQaVerdict["hard_gates"],
    persuasion_score: (r.persuasion_score as number | null) ?? null,
    persuasion_rubric: (r.persuasion_rubric as CopyQaPersuasionRubric | null) ?? null,
    scroll_stop: r.scroll_stop as CopyQaScrollStop,
    verdict_reason: (r.verdict_reason as string | null) || "",
    retry_index: (r.retry_index as number | null) ?? 0,
    created_at: r.created_at as string,
  };
}
