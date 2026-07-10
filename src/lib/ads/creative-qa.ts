/**
 * creative-qa — the visual gate the Ad Creative Agent (Dahlia) runs on every generated static before
 * it lands in [[media-buyer-agent|Bianca]]'s ready-to-test bin. The [[creative-brief]] guarantees the
 * CLAIMS are true by construction (grounded in [[../product-intelligence]]); what a text-to-image model
 * can still get wrong is the RENDER — garbled/dropped headline text, a bare sticker price, a cartoon
 * "before/after", or a fabricated authenticity caption ("Candid photos from her home"). Those are all
 * VISUAL defects, so we check them with a vision pass (Opus) rather than trusting the prompt.
 *
 * Returns a structured verdict; the agent regenerates on fail (up to a retry cap). See
 * [[../../../docs/brain/reference/meta-scaling-methodology]] (price-on-static + fabrication rules).
 */
import sharp from "sharp";
import { OPUS_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import type { GeneratedCreative } from "@/lib/ads/creative-generate";

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
  };
}

const QA_SYSTEM = `You are a meticulous ad-creative QA reviewer for a paid-social static image. You are given the rendered ad plus the EXACT copy strings it is supposed to contain. Your only job is to catch RENDER defects — you do NOT judge marketing quality or claims.

Check each item and return ONLY a JSON object (no prose):
{
  "headlineExact": boolean,        // the headline renders EXACTLY as given — no dropped, repeated, misspelled, or garbled words
  "textLegible": boolean,          // ALL text on the image is real, correctly-spelled words (no gibberish like "IMPUSEO", "real Ife", "coffee coffee")
  "noBarePrice": boolean,          // NO bare sticker/MSRP price shown alone; a price is OK only as strikethrough→discount or per-serving value
  "noFabricatedPhotoCaption": boolean, // NO text claiming an image is a real/candid/verified/authentic photo or "taken from her phone/home". Plain "Before"/"After" labels are fine
  "transformationPhotorealistic": boolean, // IF there is a before/after transformation image: it is photorealistic (a real-looking photograph), NOT a cartoon/illustration/drawing/3D-CGI render. If there is no transformation image, return true
  "issues": string[]               // one short string per failed check explaining what's wrong; empty array if all pass
}`;

/** Downscale to Anthropic's optimal vision size (1568px) + re-encode JPEG — small + token-efficient. */
async function normalizeForVision(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).resize({ width: 1568, height: 1568, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
}

/**
 * Visually QA a generated creative against the exact copy it should contain. On any check failing,
 * `pass` is false and `issues` explains why — the caller (Dahlia's loop) regenerates. Fails OPEN on a
 * vision-service error is NOT allowed: a QA we couldn't run returns `pass:false` so nothing unchecked
 * reaches the bin.
 */
export async function qaCreative(
  workspaceId: string,
  gen: Pick<GeneratedCreative, "buffer" | "expectedCopy"> & { hasTransformation?: boolean },
): Promise<CreativeQAVerdict> {
  const failClosed = (reason: string): CreativeQAVerdict => ({
    pass: false,
    issues: [reason],
    checks: { headlineExact: false, textLegible: false, noBarePrice: false, noFabricatedPhotoCaption: false, transformationPhotorealistic: false },
  });
  if (!ANTHROPIC_API_KEY) return failClosed("qa_no_anthropic_key");

  let normalized: Buffer;
  try {
    normalized = await normalizeForVision(gen.buffer);
  } catch {
    return failClosed("qa_image_undecodable");
  }

  const expected = [
    `HEADLINE: "${gen.expectedCopy.headline}"`,
    gen.expectedCopy.offer ? `OFFER: "${gen.expectedCopy.offer}"` : "OFFER: none",
    `TRUST BAR: "${gen.expectedCopy.trust}"`,
    `Has a before/after transformation image: ${gen.hasTransformation ? "yes" : "no"}`,
  ].join("\n");

  let json: { headlineExact?: boolean; textLegible?: boolean; noBarePrice?: boolean; noFabricatedPhotoCaption?: boolean; transformationPhotorealistic?: boolean; issues?: string[]; usage?: unknown };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: OPUS_MODEL,
        max_tokens: 1024,
        system: QA_SYSTEM,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: normalized.toString("base64") } },
            { type: "text", text: `Expected copy:\n${expected}\n\nQA this rendered ad. Return only the JSON verdict.` },
          ],
        }],
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
  };
  const pass = Object.values(checks).every(Boolean);
  const issues = Array.isArray(json.issues) ? json.issues.filter((s): s is string => typeof s === "string") : [];
  if (!pass && issues.length === 0) {
    for (const [k, v] of Object.entries(checks)) if (!v) issues.push(`failed: ${k}`);
  }
  return { pass, issues, checks };
}
