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
