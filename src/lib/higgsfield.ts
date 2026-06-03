/**
 * Higgsfield Cloud API client (cloud.higgsfield.ai).
 *
 * One vendor covers the three generative surfaces the ad tool needs:
 *   - Soul       — image gen ("avatar holding product" hero shot)
 *   - DoP        — image-to-video (b-roll clips)
 *   - Speak      — talking-head lip-sync (speech2video)
 *   - Audio      — text-to-speech for the script (optional; ElevenLabs alt)
 *
 * Auth is a dual-credential model: an API key + a secret, both per-workspace,
 * stored AES-256-GCM encrypted on `workspaces` (see src/lib/crypto.ts). There
 * is NO global Higgsfield account — every call resolves credentials for one
 * workspace.
 *
 * Async jobs return a `job_set_id`; we poll `getJobStatus` until completed.
 * Every call is logged to `ad_jobs` via loggedHiggsfieldFetch for cost-audit
 * and replay (same discipline as src/lib/appstle-call-log.ts).
 *
 * NOTE: endpoint paths + payload shapes below are the integration contract.
 * They follow the published Higgsfield references gathered in the spec; verify
 * against live docs when wiring real credentials (see brain integrations/higgsfield.md).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";

const BASE_URL = process.env.HIGGSFIELD_BASE_URL || "https://cloud.higgsfield.ai";

// Model ids (from the Higgsfield resources catalog).
export const HIGGSFIELD_MODELS = {
  soul: "soul",
  dop: "dop",
  speak: "speak",
} as const;

// $1 = 16 credits.
export const CREDITS_PER_DOLLAR = 16;
export function creditsToCents(credits: number): number {
  return Math.round((credits / CREDITS_PER_DOLLAR) * 100);
}

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
  return {
    apiKey: decrypt(ws.higgsfield_api_key_encrypted),
    secret: decrypt(ws.higgsfield_secret_encrypted),
  };
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
  /** When true, persist a row in ad_jobs. Probe/list calls skip persistence. */
  persist?: boolean;
}

/**
 * Single fetch wrapper: resolves creds, signs the request, calls Higgsfield,
 * and (unless persist=false) writes an ad_jobs row for audit/replay.
 * Returns the parsed JSON body + the ad_jobs row id (if persisted).
 */
export async function loggedHiggsfieldFetch(args: LoggedFetchArgs): Promise<{ ok: boolean; status: number; json: any; jobId: string | null }> {
  const creds = await getHiggsfieldCredentials(args.workspaceId);
  if (!creds) throw new Error("higgsfield_not_connected");

  const admin = createAdminClient();
  const url = `${BASE_URL}${args.path}`;
  const method = args.method || "POST";

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "hf-api-key": creds.apiKey,
      "hf-secret": creds.secret,
    },
    body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
  });

  let json: any = null;
  try {
    json = await res.clone().json();
  } catch {
    json = { _raw: await res.clone().text().catch(() => "") };
  }

  let jobId: string | null = null;
  if (args.persist !== false && args.jobType !== "probe") {
    const jobSetId: string | null = json?.job_set_id || json?.id || null;
    const { data: jobRow } = await admin
      .from("ad_jobs")
      .insert({
        workspace_id: args.workspaceId,
        campaign_id: args.campaignId ?? null,
        video_id: args.videoId ?? null,
        job_type: args.jobType,
        higgsfield_job_set_id: jobSetId,
        status: res.ok ? "queued" : "failed",
        request_payload: redactCreds(args.body),
        response_payload: json,
        cost_credits: args.costCredits ?? 0,
        error: res.ok ? null : `http_${res.status}`,
      })
      .select("id")
      .single();
    jobId = jobRow?.id ?? null;
  }

  return { ok: res.ok, status: res.status, json, jobId };
}

function redactCreds(body: unknown): unknown {
  if (!body || typeof body !== "object") return body ?? null;
  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of Object.keys(clone)) {
    if (/key|secret|token/i.test(k)) clone[k] = "[redacted]";
  }
  return clone;
}

// ── High-level operations ───────────────────────────────────────────────────

export interface CreateCharacterArgs {
  workspaceId: string;
  name: string;
  imageUrls: string[]; // signed, public-readable for the duration of the call
}

/** Mint a persistent Higgsfield character (40 credits / ~$2.50). */
export async function createCharacter(args: CreateCharacterArgs): Promise<{ characterId: string | null; jobId: string | null }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "create_character",
    path: "/v1/characters",
    body: { name: args.name, reference_image_urls: args.imageUrls },
    costCredits: 40,
  });
  if (!r.ok) throw new Error(`higgsfield_create_character_${r.status}`);
  return { characterId: r.json?.character_id || r.json?.id || null, jobId: r.jobId };
}

export interface SoulImageArgs {
  workspaceId: string;
  characterId: string;
  prompt: string;
  referenceImageUrls?: string[];
  quality?: "720p" | "1080p";
  campaignId?: string;
}

/** Generate a Soul image (avatar + product hero). ~3 credits @ 1080p. */
export async function generateSoulImage(args: SoulImageArgs): Promise<{ jobSetId: string | null; jobId: string | null }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "soul_image",
    path: "/v1/soul/generate",
    campaignId: args.campaignId,
    body: {
      model: HIGGSFIELD_MODELS.soul,
      character_id: args.characterId,
      prompt: args.prompt,
      reference_image_urls: args.referenceImageUrls ?? [],
      quality: args.quality ?? "1080p",
    },
    costCredits: 3,
  });
  if (!r.ok) throw new Error(`higgsfield_soul_${r.status}`);
  return { jobSetId: r.json?.job_set_id || r.json?.id || null, jobId: r.jobId };
}

export interface SoulPortraitArgs {
  workspaceId: string;
  prompt: string;
  quality?: "720p" | "1080p";
  seed?: number;
}

/**
 * Soul TEXT-TO-IMAGE — generate a brand-new person from a description (no
 * existing character). Used to mint avatar candidates from a demographic
 * archetype brief, so the operator never has to upload reference photos. ~3
 * credits. The chosen portrait is then fed to createCharacter() to become a
 * persistent, reusable character.
 */
export async function generateSoulPortrait(args: SoulPortraitArgs): Promise<{ jobSetId: string | null; jobId: string | null }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "soul_image",
    path: "/v1/soul/generate",
    body: {
      model: HIGGSFIELD_MODELS.soul,
      prompt: args.prompt,
      quality: args.quality ?? "1080p",
      ...(args.seed !== undefined ? { seed: args.seed } : {}),
    },
    costCredits: 3,
  });
  if (!r.ok) throw new Error(`higgsfield_soul_portrait_${r.status}`);
  return { jobSetId: r.json?.job_set_id || r.json?.id || null, jobId: r.jobId };
}

export interface DopVideoArgs {
  workspaceId: string;
  imageUrl: string;
  motionId: string;
  prompt?: string;
  quality?: "720p" | "1080p";
  campaignId?: string;
  videoId?: string;
}

/** Image-to-video b-roll clip (5s). ~9 credits / ~$0.56. */
export async function generateDopVideo(args: DopVideoArgs): Promise<{ jobSetId: string | null; jobId: string | null }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "dop_video",
    path: "/v1/dop/generate",
    campaignId: args.campaignId,
    videoId: args.videoId,
    body: {
      model: HIGGSFIELD_MODELS.dop,
      input_image: args.imageUrl,
      motion_id: args.motionId,
      prompt: args.prompt ?? "",
      quality: args.quality ?? "1080p",
    },
    costCredits: 9,
  });
  if (!r.ok) throw new Error(`higgsfield_dop_${r.status}`);
  return { jobSetId: r.json?.job_set_id || r.json?.id || null, jobId: r.jobId };
}

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

/** Talking-head lip-sync from a hero image + audio. ~$0.10/sec. Max 15s/gen. */
export async function generateSpeakVideo(args: SpeakVideoArgs): Promise<{ jobSetId: string | null; jobId: string | null }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "speak_video",
    path: "/v1/speak/generate",
    campaignId: args.campaignId,
    videoId: args.videoId,
    body: {
      model: HIGGSFIELD_MODELS.speak,
      input_image: args.imageUrl,
      input_audio: args.audioUrl,
      prompt: args.prompt,
      duration: args.duration,
      quality: args.quality ?? "1080p",
    },
    // ~$0.10/sec → credits ≈ duration * 1.6
    costCredits: Math.round(args.duration * 1.6),
  });
  if (!r.ok) throw new Error(`higgsfield_speak_${r.status}`);
  return { jobSetId: r.json?.job_set_id || r.json?.id || null, jobId: r.jobId };
}

export interface TtsAudioArgs {
  workspaceId: string;
  text: string;
  voiceId: string;
  campaignId?: string;
}

/** Higgsfield Audio TTS (default V1 TTS vendor). */
export async function generateTtsAudio(args: TtsAudioArgs): Promise<{ jobSetId: string | null; jobId: string | null }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId: args.workspaceId,
    jobType: "tts_audio",
    path: "/v1/audio/tts",
    campaignId: args.campaignId,
    body: { text: args.text, voice_id: args.voiceId },
    costCredits: 1,
  });
  if (!r.ok) throw new Error(`higgsfield_tts_${r.status}`);
  return { jobSetId: r.json?.job_set_id || r.json?.id || null, jobId: r.jobId };
}

export type HiggsfieldStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw";

/** Poll a job set. Returns normalized status + any output urls. */
export async function getJobStatus(workspaceId: string, jobSetId: string): Promise<{ status: HiggsfieldStatus; outputUrls: string[] }> {
  const r = await loggedHiggsfieldFetch({
    workspaceId,
    jobType: "probe",
    path: `/v1/job-sets/${jobSetId}`,
    method: "GET",
    persist: false,
  });
  const raw = r.json || {};
  const jobs: any[] = raw.jobs || raw.results || (Array.isArray(raw) ? raw : []);
  const outputUrls: string[] = [];
  for (const j of jobs) {
    const u = j?.results?.raw?.url || j?.output_url || j?.url;
    if (u) outputUrls.push(u);
  }
  const rawStatus = String(raw.status || raw.state || jobs[0]?.status || "in_progress").toLowerCase();
  let status: HiggsfieldStatus = "in_progress";
  if (rawStatus.includes("complet") || rawStatus === "succeeded" || rawStatus === "done") status = "completed";
  else if (rawStatus.includes("nsfw")) status = "nsfw";
  else if (rawStatus.includes("fail") || rawStatus.includes("error")) status = "failed";
  else if (rawStatus.includes("queue")) status = "queued";
  return { status, outputUrls };
}

/** Poll until terminal (completed/failed/nsfw) or timeout. */
export async function pollJobUntilDone(
  workspaceId: string,
  jobSetId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<{ status: HiggsfieldStatus; outputUrls: string[] }> {
  const intervalMs = opts.intervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 240000;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const s = await getJobStatus(workspaceId, jobSetId);
    if (s.status === "completed" || s.status === "failed" || s.status === "nsfw") return s;
    if (Date.now() > deadline) return { status: "failed", outputUrls: [] };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Static catalog of motion presets (cached client-side). */
export async function listMotions(workspaceId: string): Promise<any[]> {
  const r = await loggedHiggsfieldFetch({ workspaceId, jobType: "probe", path: "/v1/motions", method: "GET", persist: false });
  return r.json?.motions || r.json || [];
}

export async function listStyles(workspaceId: string): Promise<any[]> {
  const r = await loggedHiggsfieldFetch({ workspaceId, jobType: "probe", path: "/v1/styles", method: "GET", persist: false });
  return r.json?.styles || r.json || [];
}

/** Cheap auth probe used by the settings card "verify" step. */
export async function probeHiggsfieldAuth(workspaceId: string): Promise<{ ok: boolean; status: number }> {
  const creds = await getHiggsfieldCredentials(workspaceId);
  if (!creds) return { ok: false, status: 0 };
  const r = await loggedHiggsfieldFetch({ workspaceId, jobType: "probe", path: "/v1/motions", method: "GET", persist: false });
  return { ok: r.ok, status: r.status };
}
