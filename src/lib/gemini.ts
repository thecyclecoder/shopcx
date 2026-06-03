/**
 * Google AI Studio (Gemini) client — the ad-tool "holding product" engine.
 *
 * Nano Banana Pro (`gemini-3-pro-image`) is a multi-image-fusion model: give it
 * the avatar face + the product's isolated image + a prompt and it composes a
 * photorealistic "person holding the product" shot — identity-locked, with
 * sharp packaging text and correct anatomy (much better than Higgsfield's
 * Seedream/Soul combine). Per-workspace API key, AES-256-GCM encrypted.
 *
 * Auth: `x-goog-api-key: {API_KEY}` (NOT Bearer). Billing must be enabled on the
 * Google Cloud project or the Pro image model 429s "prepayment credits depleted".
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const GEMINI_BASE = process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta";
export const NANO_BANANA_PRO_MODEL = "gemini-3-pro-image"; // Nano Banana Pro
export const NANO_BANANA_MODEL = "gemini-2.5-flash-image"; // Nano Banana (cheaper fallback)

export async function getGeminiCredentials(workspaceId: string): Promise<{ apiKey: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin.from("workspaces").select("gemini_api_key_encrypted").eq("id", workspaceId).single();
  if (data?.gemini_api_key_encrypted) return { apiKey: decrypt(data.gemini_api_key_encrypted) };
  if (process.env.GEMINI_API_KEY) return { apiKey: process.env.GEMINI_API_KEY };
  return null;
}

async function toInlineData(url: string): Promise<{ mime_type: string; data: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image_fetch_${res.status}`);
  const ct = res.headers.get("content-type") || "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return { mime_type: ct.startsWith("image/") ? ct : "image/png", data: buf.toString("base64") };
}

export interface NanoBananaProArgs {
  workspaceId: string;
  prompt: string;
  imageUrls: string[]; // [face, product, …] — referenced as "the first/second image" in the prompt
  model?: string;
}

/**
 * Compose images via Nano Banana Pro. Synchronous — the image comes back inline
 * in the response (~10-30s), no polling. Returns the raw image bytes; the caller
 * uploads to storage. Throws `gemini_not_connected` if no key, or `gemini_429…`
 * if billing isn't enabled.
 */
export async function generateNanoBananaProCombine(args: NanoBananaProArgs): Promise<{ buffer: Buffer; mimeType: string }> {
  const creds = await getGeminiCredentials(args.workspaceId);
  if (!creds) throw new Error("gemini_not_connected");
  const images = await Promise.all(args.imageUrls.filter(Boolean).map(toInlineData));
  const body = {
    contents: [{ parts: [{ text: args.prompt }, ...images.map((im) => ({ inline_data: im }))] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  };
  const res = await fetch(`${GEMINI_BASE}/models/${args.model || NANO_BANANA_PRO_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": creds.apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gemini_${res.status}:${(json?.error?.message || "").slice(0, 100)}`);
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p: any) => p.inline_data || p.inlineData);
  if (!img) throw new Error("gemini_no_image");
  const inline = img.inline_data || img.inlineData;
  return { buffer: Buffer.from(inline.data, "base64"), mimeType: inline.mime_type || inline.mimeType || "image/png" };
}

// ── Veo 3 video generation (talking head + b-roll) ──────────────────────────
export const VEO_MODEL = "veo-3.1-generate-preview"; // Veo 3.1 (newest)
export const VEO_FAST_MODEL = "veo-3.1-fast-generate-preview";

export interface VeoVideoArgs {
  workspaceId: string;
  prompt: string;
  imageUrl?: string; // optional first-frame image (image-to-video)
  aspectRatio?: "9:16" | "16:9" | "1:1";
  resolution?: "720p" | "1080p";
  model?: string;
  /** poll cadence/timeout for the long-running op */
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Generate a video with Veo 3 (image-to-video when imageUrl is set, else
 * text-to-video). Long-running: kicks off `predictLongRunning`, polls the
 * operation, then downloads the resulting MP4. Returns the raw bytes (caller
 * uploads to storage). ~8s clips. Veo bakes in its own authentic audio.
 */
export async function generateVeoVideo(args: VeoVideoArgs): Promise<{ buffer: Buffer; mimeType: string }> {
  const creds = await getGeminiCredentials(args.workspaceId);
  if (!creds) throw new Error("gemini_not_connected");
  const model = args.model || VEO_MODEL;

  const instance: any = { prompt: args.prompt };
  if (args.imageUrl) {
    const img = await toInlineData(args.imageUrl);
    instance.image = { bytesBase64Encoded: img.data, mimeType: img.mime_type };
  }
  const body = {
    instances: [instance],
    parameters: { aspectRatio: args.aspectRatio || "9:16", resolution: args.resolution || "720p" },
  };

  const start = await fetch(`${GEMINI_BASE}/models/${model}:predictLongRunning`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": creds.apiKey },
    body: JSON.stringify(body),
  });
  const startJson = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(`veo_${start.status}:${(startJson?.error?.message || "").slice(0, 100)}`);
  const opName: string | undefined = startJson?.name;
  if (!opName) throw new Error("veo_no_operation");

  const intervalMs = args.intervalMs ?? 8000;
  const deadline = Date.now() + (args.timeoutMs ?? 300000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pr = await fetch(`${GEMINI_BASE}/${opName}`, { headers: { "x-goog-api-key": creds.apiKey } });
    const pj = await pr.json().catch(() => ({}));
    if (pj?.done) {
      if (pj.error) throw new Error(`veo_op:${(pj.error?.message || "").slice(0, 100)}`);
      const resp = pj.response || {};
      const sample = resp.generateVideoResponse?.generatedSamples?.[0] || resp.generatedSamples?.[0] || resp.videos?.[0];
      const uri: string | undefined = sample?.video?.uri || sample?.video?.url || sample?.uri;
      if (!uri) throw new Error("veo_no_video");
      const dl = await fetch(uri, { headers: { "x-goog-api-key": creds.apiKey } });
      if (!dl.ok) throw new Error(`veo_download_${dl.status}`);
      return { buffer: Buffer.from(await dl.arrayBuffer()), mimeType: "video/mp4" };
    }
    if (Date.now() > deadline) throw new Error("veo_timeout");
  }
}

// ── Lyria music bed ──────────────────────────────────────────────────────────
export const LYRIA_MODEL = "lyria-3-clip-preview";

/**
 * Generate a short instrumental music bed via Lyria. Synchronous — audio comes
 * back inline (`generateContent`), like Nano Banana Pro. Used for the ONE low
 * music bed under the ad (b-roll stays muted/ASMR; the VO spine is the talking
 * segments' own audio). Returns raw bytes (caller uploads). ~25-30s clips.
 */
export async function generateLyriaMusic(args: { workspaceId: string; prompt: string; model?: string }): Promise<{ buffer: Buffer; mimeType: string }> {
  const creds = await getGeminiCredentials(args.workspaceId);
  if (!creds) throw new Error("gemini_not_connected");
  const res = await fetch(`${GEMINI_BASE}/models/${args.model || LYRIA_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": creds.apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: args.prompt }] }] }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`lyria_${res.status}:${(json?.error?.message || "").slice(0, 100)}`);
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const part = parts.find((p: any) => p.inline_data || p.inlineData);
  if (!part) throw new Error("lyria_no_audio");
  const inline = part.inline_data || part.inlineData;
  return { buffer: Buffer.from(inline.data, "base64"), mimeType: inline.mime_type || inline.mimeType || "audio/wav" };
}

/** Cheap auth probe for the settings "Verify" button (list models). */
export async function probeGeminiAuth(workspaceId: string): Promise<{ ok: boolean; status: number }> {
  const creds = await getGeminiCredentials(workspaceId);
  if (!creds) return { ok: false, status: 0 };
  const res = await fetch(`${GEMINI_BASE}/models`, { headers: { "x-goog-api-key": creds.apiKey } });
  return { ok: res.ok, status: res.status };
}
