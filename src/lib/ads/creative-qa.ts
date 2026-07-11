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

// ── box-session QC (dahlia-creative-qc-via-box-session Phase 1) ─────────────────────────────────
// Same verdict shape as qaCreative, but the vision pass is a top-level `claude -p` on Max instead
// of a direct Opus API call — so the lane never needs an ANTHROPIC_API_KEY and Dahlia's QC works
// on the box for every product. The `dispatch` callback is injected by the caller
// (scripts/builder-worker.ts runAdCreativeJob) — it spawns `claude -p` on Max, waits for the JSON
// verdict, and returns raw text + an error flag. Keeping the spawn out of `src/` follows the
// existing skill pattern (seed-product, spec-review, …): src/ ships the pure logic; scripts/
// owns the process boundary.

/** Injected by the caller: run one `claude -p` box session (kind='ad-creative-qc') on Max and
 *  return its raw result text + an error flag. Implementations MUST unset ANTHROPIC_API_KEY in
 *  the spawned env (max sandbox) and MUST be fail-closed — a spawn error / cap / timeout MUST
 *  surface as `isError:true` so qaCreativeViaBoxSession converts it to `pass:false`. */
export type QcSessionDispatcher = (prompt: string) => Promise<{ resultText: string; isError: boolean }>;

const QA_BOX_SESSION_INSTRUCTION = `Use the creative-qc skill to visually QC ONE rendered ad against the exact copy strings it should contain. You are on Max (no ANTHROPIC_API_KEY). READ the image with the Read tool — Claude Code renders the JPEG visually to you — then judge each of the five render defects and emit ONLY the CreativeQAVerdict JSON (no prose, no code fences, no wrapper).`;

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
  gen: Pick<GeneratedCreative, "buffer" | "expectedCopy"> & { hasTransformation?: boolean },
  dispatch: QcSessionDispatcher,
): Promise<CreativeQAVerdict> {
  const failClosed = (reason: string): CreativeQAVerdict => ({
    pass: false,
    issues: [reason],
    checks: { headlineExact: false, textLegible: false, noBarePrice: false, noFabricatedPhotoCaption: false, transformationPhotorealistic: false },
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

  try {
    const prompt = [
      QA_BOX_SESSION_INSTRUCTION,
      "",
      `IMAGE: ${imagePath}`,
      `HEADLINE: "${gen.expectedCopy.headline}"`,
      gen.expectedCopy.offer ? `OFFER: "${gen.expectedCopy.offer}"` : "OFFER: none",
      `TRUST BAR: "${gen.expectedCopy.trust}"`,
      `HAS_TRANSFORMATION: ${gen.hasTransformation ? "yes" : "no"}`,
      "",
      `Return ONLY the CreativeQAVerdict JSON — { pass, issues, checks: { headlineExact, textLegible, noBarePrice, noFabricatedPhotoCaption, transformationPhotorealistic } }. Any check you cannot confidently judge is false (fail-closed).`,
    ].join("\n");

    let dispatchResult: { resultText: string; isError: boolean };
    try {
      dispatchResult = await dispatch(prompt);
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
  }
}
