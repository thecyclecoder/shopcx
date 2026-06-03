/**
 * Higgsfield Platform API client (platform.higgsfield.ai).
 *
 * Verified against the official Higgsfield SDK + docs (2026-06):
 *   - Base URL: https://platform.higgsfield.ai
 *   - Auth:     Authorization: Key {KEY_ID}:{KEY_SECRET}   (single header)
 *   - Soul text2image:        POST /v1/text2image/soul
 *   - Soul image-to-image:    POST /v1/text2image/soul  (custom_reference_id + strength)
 *   - DoP image-to-video:     POST /v1/image2video/dop
 *   - Speak speech2video:     POST /v1/speak/higgsfield
 *   - Status polling:         GET  /requests/{request_id}/status
 *   Response shape: { status, request_id, images:[{url}] | video:{url} }
 *   status ∈ queued | in_progress | completed | failed | nsfw
 *
 * Credentials are per-workspace, AES-256-GCM encrypted on `workspaces`. Every
 * call is logged to `ad_jobs` for cost-audit + replay.
 *
 * See docs/brain/integrations/higgsfield.md for the full API contract.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const BASE_URL = process.env.HIGGSFIELD_BASE_URL || "https://platform.higgsfield.ai";

export const HIGGSFIELD_MODELS = { soul: "soul", dop: "dop", speak: "speak" } as const;

// $1 = 16 credits.
export const CREDITS_PER_DOLLAR = 16;
export function creditsToCents(credits: number): number {
  return Math.round((credits / CREDITS_PER_DOLLAR) * 100);
}

// width_and_height enums accepted by Soul text2image (subset).
export const SOUL_SIZES = {
  portrait_9x16: "1152x2048",
  portrait_3x4: "1536x2048",
  square: "1536x1536",
  landscape_16x9: "2048x1152",
} as const;

export type HiggsfieldJobType = "create_character" | "soul_image" | "dop_video" | "speak_video" | "tts_audio";

export interface HiggsfieldCredentials {
  apiKey: string;
  secret: string;
}

export async function getHiggsfieldCredentials(workspaceId: string): Promise<HiggsfieldCredentials | null> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("higgsfield_api_key_encrypted, higgsfield_secret_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!ws?.higgsfield_api_key_encrypted || !ws?.higgsfield_secret_encrypted) return null;
  return { apiKey: decrypt(ws.higgsfield_api_key_encrypted), secret: decrypt(ws.higgsfield_secret_encrypted) };
}

interface LoggedFetchArgs {
  workspaceId: string;
  jobType: HiggsfieldJobType | "probe";
  path: string;
  method?: string;
  body?: unknown;
  campaignId?: string | null;
  videoId?: string | null;
  costCredits?: number;
  persist?: boolean;
}

/** Pull the output url(s) out of a Higgsfield response (images[] or video). */
function extractUrls(json: any): string[] {
  const urls: string[] = [];
  if (Array.isArray(json?.images)) for (const im of json.images) if (im?.url) urls.push(im.url);
  if (json?.video?.url) urls.push(json.video.url);
  // JobSet-style fallback (SDK): jobs[].results.raw.url
  const jobs: any[] = json?.jobs || json?.results || [];
  if (Array.isArray(jobs)) for (const j of jobs) { const u = j?.results?.raw?.url || j?.output_url || j?.url; if (u) urls.push(u); }
  return urls;
}

export async function loggedHiggsfieldFetch(args: LoggedFetchArgs): Promise<{ ok: boolean; status: number; json: any; jobId: string | null; requestId: string | null; outputUrls: string[] }> {
  const creds = await getHiggsfieldCredentials(args.workspaceId);
  if (!creds) throw new Error("higgsfield_not_connected");

  const admin = createAdminClient();
  const url = `${BASE_URL}${args.path}`;
  const method = args.method || "POST";

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${creds.apiKey}:${creds.secret}`,
    },
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });

  let json: any = null;
  try {
    json = await res.clone().json();
  } catch {
    json = { _raw: await res.clone().text().catch(() => "") };
  }

  const requestId: string | null = json?.request_id || json?.id || null;
  const outputUrls = extractUrls(json);

  let jobId: string | null = null;
  if (args.persist !== false && args.jobType !== "probe") {
    const { data: jobRow } = await admin
      .from("ad_jobs")
      .insert({
        workspace_id: args.workspaceId,
        campaign_id: args.campaignId ?? null,
        video_id: args.videoId ?? null,
        job_type: args.jobType,
        higgsfield_job_set_id: requestId,
        status: res.ok ? (json?.status === "completed" ? "completed" : "queued") : "failed",
        request_payload: redactCreds(args.body),
        response_payload: json,
        cost_credits: args.costCredits ?? 0,
        error: res.ok ? null : `http_${res.status}`,
      })
      .select("id")
      .single();
    jobId = jobRow?.id ?? null;
  }

  return { ok: res.ok, status: res.status, json, jobId, requestId, outputUrls };
}

function redactCreds(body: unknown): unknown {
  if (!body || typeof body !== "object") return body ?? null;
  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of Object.keys(clone)) if (/key|secret|token/i.test(k)) clone[k] = "[redacted]";
  return clone;
}

// ── Status polling ──────────────────────────────────────────────────────────
export type HiggsfieldStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw";

function normalizeStatus(raw: string): HiggsfieldStatus {
  const s = String(raw || "in_progress").toLowerCase();
  if (s.includes("complet") || s === "succeeded" || s === "done" || s === "success") return "completed";
  if (s.includes("nsfw")) return "nsfw";
  if (s.includes("fail") || s.includes("error") || s.includes("cancel")) return "failed";
  if (s.includes("queue")) return "queued";
  return "in_progress";
}

export async function getJobStatus(workspaceId: string, requestId: string): Promise<{ status: HiggsfieldStatus; outputUrls: string[] }> {
  const r = await loggedHiggsfieldFetch({ workspaceId, jobType: "probe", path: `/requests/${requestId}/status`, method: "GET", persist: false });
  return { status: normalizeStatus(r.json?.status), outputUrls: r.outputUrls };
}

export async function pollJobUntilDone(
  workspaceId: string,
  requestId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<{ status: HiggsfieldStatus; outputUrls: string[] }> {
  const intervalMs = opts.intervalMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 240000;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const s = await getJobStatus(workspaceId, requestId);
    if (s.status === "completed" || s.status === "failed" || s.status === "nsfw") return s;
    if (Date.now() > deadline) return { status: "failed", outputUrls: [] };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Soul text-to-image (avatar face candidates — no reference) ───────────────
export interface SoulPortraitArgs {
  workspaceId: string;
  prompt: string;
  size?: string; // a SOUL_SIZES value
  quality?: "720p" | "1080p";
  seed?: number;
}

/**
 * Generate a brand-new person from a text prompt (Soul text2image). Returns the
 * request id + any immediately-available image urls; if the response is async,
 * poll getJobStatus(requestId). ~3 credits.
 */
export async function generateSoulPortrait(args: SoulPortraitArgs): Promise<{ jobSetId: string | null; jobId: string | null; outputUrls: string[] }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "soul_image",
    path: "/v1/text2image/soul",
    body: {
      params: {
        prompt: args.prompt,
        width_and_height: args.size || SOUL_SIZES.portrait_9x16,
        quality: args.quality ?? "1080p",
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      },
    },
    costCredits: 3,
  });
  if (!r.ok) throw new Error(`higgsfield_soul_${r.status}`);
  return { jobSetId: r.requestId, jobId: r.jobId, outputUrls: r.outputUrls };
}

// ── Soul image (hero — optional custom reference) ────────────────────────────
export interface SoulImageArgs {
  workspaceId: string;
  prompt: string;
  customReferenceId?: string; // a registered Higgsfield custom reference
  customReferenceStrength?: number;
  size?: string;
  quality?: "720p" | "1080p";
  campaignId?: string;
}

export async function generateSoulImage(args: SoulImageArgs): Promise<{ jobSetId: string | null; jobId: string | null; outputUrls: string[] }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "soul_image",
    path: "/v1/text2image/soul",
    campaignId: args.campaignId,
    body: {
      params: {
        prompt: args.prompt,
        width_and_height: args.size || SOUL_SIZES.portrait_9x16,
        quality: args.quality ?? "1080p",
        ...(args.customReferenceId ? { custom_reference_id: args.customReferenceId, custom_reference_strength: args.customReferenceStrength ?? 0.8 } : {}),
      },
    },
    costCredits: 3,
  });
  if (!r.ok) throw new Error(`higgsfield_soul_${r.status}`);
  return { jobSetId: r.requestId, jobId: r.jobId, outputUrls: r.outputUrls };
}

// ── DoP image-to-video (b-roll) ──────────────────────────────────────────────
export interface DopVideoArgs {
  workspaceId: string;
  imageUrl: string;
  motionId?: string;
  prompt?: string;
  campaignId?: string;
  videoId?: string;
}

export async function generateDopVideo(args: DopVideoArgs): Promise<{ jobSetId: string | null; jobId: string | null; outputUrls: string[] }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "dop_video",
    path: "/v1/image2video/dop",
    campaignId: args.campaignId,
    videoId: args.videoId,
    body: {
      params: {
        model: HIGGSFIELD_MODELS.dop,
        prompt: args.prompt ?? "",
        input_images: [{ type: "image_url", image_url: args.imageUrl }],
        ...(args.motionId ? { motions: [args.motionId] } : {}),
      },
    },
    costCredits: 9,
  });
  if (!r.ok) throw new Error(`higgsfield_dop_${r.status}`);
  return { jobSetId: r.requestId, jobId: r.jobId, outputUrls: r.outputUrls };
}

// ── Speak speech2video (talking head) ────────────────────────────────────────
export interface SpeakVideoArgs {
  workspaceId: string;
  imageUrl: string;
  audioUrl: string;
  prompt: string;
  duration: 5 | 10 | 15;
  quality?: "720p" | "1080p";
  campaignId?: string;
  videoId?: string;
}

export async function generateSpeakVideo(args: SpeakVideoArgs): Promise<{ jobSetId: string | null; jobId: string | null; outputUrls: string[] }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "speak_video",
    path: "/v1/speak/higgsfield",
    campaignId: args.campaignId,
    videoId: args.videoId,
    body: {
      params: {
        input_image: { type: "image_url", image_url: args.imageUrl },
        input_audio: { type: "audio_url", audio_url: args.audioUrl },
        prompt: args.prompt,
        quality: args.quality ?? "1080p",
        duration: String(args.duration),
      },
    },
    costCredits: Math.round(args.duration * 1.6),
  });
  if (!r.ok) throw new Error(`higgsfield_speak_${r.status}`);
  return { jobSetId: r.requestId, jobId: r.jobId, outputUrls: r.outputUrls };
}

// ── TTS (vendor TBD — endpoint unverified; ElevenLabs is the fallback) ────────
export interface TtsAudioArgs {
  workspaceId: string;
  text: string;
  voiceId: string;
  campaignId?: string;
}

export async function generateTtsAudio(args: TtsAudioArgs): Promise<{ jobSetId: string | null; jobId: string | null; outputUrls: string[] }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "tts_audio",
    path: "/v1/audio/tts",
    campaignId: args.campaignId,
    body: { params: { text: args.text, voice_id: args.voiceId } },
    costCredits: 1,
  });
  if (!r.ok) throw new Error(`higgsfield_tts_${r.status}`);
  return { jobSetId: r.requestId, jobId: r.jobId, outputUrls: r.outputUrls };
}

export interface CreateCharacterArgs {
  workspaceId: string;
  name: string;
  imageUrls: string[];
}

/**
 * NOTE: Higgsfield's true "Soul ID" character requires 20+ training photos. With
 * a single chosen face we don't mint a Soul ID — the avatar simply stores the
 * chosen face image, reused as a Soul custom-reference for hero generation. This
 * returns characterId=null (no spend); the avatar row carries the face url.
 * (Full Soul-ID training is tracked as open work in the ad-render lifecycle.)
 */
export async function createCharacter(_args: CreateCharacterArgs): Promise<{ characterId: string | null; jobId: string | null }> {
  return { characterId: null, jobId: null };
}

/** Cheap auth probe for the settings "Verify" button — bad creds → 401/403. */
export async function probeHiggsfieldAuth(workspaceId: string): Promise<{ ok: boolean; status: number }> {
  const creds = await getHiggsfieldCredentials(workspaceId);
  if (!creds) return { ok: false, status: 0 };
  // GET a POST-only endpoint: 401/403 = bad auth; 404/405/200 = creds accepted.
  const res = await fetch(`${BASE_URL}/v1/text2image/soul`, { method: "GET", headers: { Authorization: `Key ${creds.apiKey}:${creds.secret}` } });
  return { ok: res.status !== 401 && res.status !== 403, status: res.status };
}

export async function listMotions(_workspaceId: string): Promise<any[]> {
  // Motions catalog is static in the Higgsfield product; returned empty here.
  return [];
}
export async function listStyles(_workspaceId: string): Promise<any[]> {
  return [];
}
