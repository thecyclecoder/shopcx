/**
 * Creative-finder VIDEO deconstruction — creative-finder-video Phase 1.
 *
 * The static finder (winning-static-creative-finder) parks every video creative at
 * `status='video_pending'` with no vision spend. This is the heavier follow-on that
 * processes those parked rows: for each `video_pending` AdLibrary creative we
 *   download the video (Bearer-keyed AdLibrary fetch)
 *   → ffmpeg keyframes (dense in the first ~3s, where the hook lives)
 *   → Whisper transcript of the audio track
 *   → run the frames + transcript through the SAME four-slot skeleton schema as
 *     statics (the literal first-2s hook = opening frame + first spoken line).
 *
 * Cost-bounded: only `video_pending` rows are picked up and each is flipped to
 * `analyzed` (or `failed`) afterwards, so a creative is never re-downloaded /
 * re-transcribed / re-visioned (dedup by `ad_key` is inherent in the status flip).
 * Download bytes + Whisper spend are logged per ad.
 *
 * Runtime requirement: an ffmpeg binary. We default to the bundled `ffmpeg-static`
 * binary and allow an `FFMPEG_PATH` env override. Where no binary is available the
 * pipeline gates off (rows stay `video_pending` — nothing is lost), mirroring the
 * `hasAdLibraryKey()` / `hasOpenAiKey()` skip pattern.
 *
 * See docs/brain/specs/creative-finder-video.md.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCreative } from "@/lib/adlibrary";
import {
  transcribeBuffer,
  whisperCostCents,
  hasOpenAiKey,
  WHISPER_MAX_BYTES,
} from "@/lib/ad-transcribe";
import { visionDeconstructFrames, type CreativeSkeleton } from "@/lib/creative-skeleton";

/** Resolve the ffmpeg binary: explicit env override → bundled ffmpeg-static. */
export function ffmpegBinary(): string | null {
  return process.env.FFMPEG_PATH?.trim() || ffmpegStatic || null;
}

export function hasFfmpeg(): boolean {
  return !!ffmpegBinary();
}

/**
 * Capture timestamps (seconds). Dense across the first ~3s — the first-2s hook is
 * where the scroll-stopper lives — then a few later beats for mechanism/proof/offer.
 */
const KEYFRAME_OFFSETS_SEC = [0, 0.5, 1, 1.5, 2, 2.5, 3, 5, 8, 12];
const MAX_FRAMES = KEYFRAME_OFFSETS_SEC.length;

/**
 * Extract JPEG keyframes from video bytes at KEYFRAME_OFFSETS_SEC. Writes the video
 * to a temp dir, runs one ffmpeg invocation per offset (`-ss` seek + single frame),
 * reads the frames back, and always cleans up the temp dir. Offsets past the clip's
 * end simply produce no file and are skipped.
 */
export async function extractKeyframes(
  videoBuffer: Buffer,
): Promise<Array<{ buffer: Buffer; contentType: string }>> {
  const bin = ffmpegBinary();
  if (!bin) throw new Error("no_ffmpeg");

  const dir = await mkdtemp(join(tmpdir(), "cf-video-"));
  const inPath = join(dir, "in.mp4");
  try {
    await writeFile(inPath, videoBuffer);

    await Promise.all(
      KEYFRAME_OFFSETS_SEC.map((sec, i) =>
        runFfmpeg(bin, [
          "-ss", String(sec),
          "-i", inPath,
          "-frames:v", "1",
          "-q:v", "3",
          "-y",
          join(dir, `frame-${String(i).padStart(2, "0")}.jpg`),
        ]),
      ),
    );

    const files = (await readdir(dir))
      .filter((f) => f.startsWith("frame-") && f.endsWith(".jpg"))
      .sort();
    const frames: Array<{ buffer: Buffer; contentType: string }> = [];
    for (const f of files) {
      const buf = await readFile(join(dir, f));
      if (buf.byteLength > 0) frames.push({ buffer: buf, contentType: "image/jpeg" });
    }
    return frames.slice(0, MAX_FRAMES);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Per-offset ffmpeg call. A non-zero exit (e.g. seek past end) is swallowed — that
 *  offset just yields no frame; we don't want one bad seek to fail the whole ad. */
function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: "ignore" });
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
}

export interface VideoDeconstructResult {
  skeleton: CreativeSkeleton | null;
  frames: number;
  transcriptChars: number;
  durationSec: number;
  bytes: number;
  whisperCents: number;
}

/**
 * Download → keyframes + transcript → four-slot skeleton for ONE video creative.
 * `creativeUrl` is the Bearer-keyed AdLibrary video resource url (stored as the
 * row's `image_url`). Transcription is best-effort — a silent / oversized / failing
 * transcript still lets vision run on the frames alone.
 */
export async function deconstructVideo(
  workspaceId: string,
  creativeUrl: string,
): Promise<VideoDeconstructResult> {
  const { buffer, contentType } = await fetchCreative(creativeUrl);
  const bytes = buffer.byteLength;

  let transcript = "";
  let durationSec = 0;
  let whisperCents = 0;
  if (hasOpenAiKey() && bytes <= WHISPER_MAX_BYTES) {
    try {
      const t = await transcribeBuffer(buffer, "ad.mp4", contentType.startsWith("video/") ? contentType : "video/mp4");
      transcript = t.text || "";
      durationSec = t.duration || 0;
      whisperCents = whisperCostCents(durationSec);
    } catch (err) {
      console.warn("[creative-finder-video] transcription failed:", err);
    }
  }

  const frames = await extractKeyframes(buffer);
  const skeleton = await visionDeconstructFrames(workspaceId, frames, transcript);

  return {
    skeleton,
    frames: frames.length,
    transcriptChars: transcript.length,
    durationSec,
    bytes,
    whisperCents,
  };
}

export interface VideoProcessResult {
  pending: number;
  analyzed: number;
  failed: number;
  bytesDownloaded: number;
  whisperCents: number;
}

const EMPTY_VIDEO_RESULT = (): VideoProcessResult => ({
  pending: 0,
  analyzed: 0,
  failed: 0,
  bytesDownloaded: 0,
  whisperCents: 0,
});

/**
 * Process this workspace's `video_pending` creative_skeletons rows into full
 * skeletons. Each row is flipped to `analyzed` (skeleton extracted) or `failed`
 * afterwards, so re-runs never re-process the same `ad_key` (cost-bounded).
 */
export async function processVideoPending(
  workspaceId: string,
  opts: { max?: number } = {},
): Promise<VideoProcessResult> {
  const admin = createAdminClient();
  const result = EMPTY_VIDEO_RESULT();

  const { data: rows } = await admin
    .from("creative_skeletons")
    .select("id, dedup_key, image_url")
    .eq("workspace_id", workspaceId)
    .eq("status", "video_pending")
    .order("days_running", { ascending: false, nullsFirst: false })
    .limit(opts.max ?? 25);

  const pending = (rows || []) as Array<{ id: string; dedup_key: string; image_url: string | null }>;
  result.pending = pending.length;

  for (const row of pending) {
    if (!row.image_url) {
      await markFailed(admin, row.id);
      result.failed++;
      continue;
    }
    try {
      const r = await deconstructVideo(workspaceId, row.image_url);
      result.bytesDownloaded += r.bytes;
      result.whisperCents += r.whisperCents;
      // Cost-bounded: log download + transcription spend per ad.
      console.log(
        `[creative-finder-video] ad_key=${row.dedup_key} bytes=${r.bytes} ` +
          `durationSec=${r.durationSec.toFixed(1)} frames=${r.frames} ` +
          `transcriptChars=${r.transcriptChars} whisperCents=${r.whisperCents.toFixed(3)}`,
      );

      if (!r.skeleton) {
        await markFailed(admin, row.id);
        result.failed++;
        continue;
      }
      const { error } = await admin
        .from("creative_skeletons")
        .update({
          media_type: "video",
          format: r.skeleton.format,
          framework: r.skeleton.framework,
          hook: r.skeleton.hook,
          mechanism_claim: r.skeleton.mechanism_claim,
          proof: r.skeleton.proof,
          offer: r.skeleton.offer,
          status: "analyzed",
          visioned_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id);
      if (error) throw new Error(error.message);
      result.analyzed++;
    } catch (err) {
      console.error(`[creative-finder-video] process failed for ${row.dedup_key}:`, err);
      await markFailed(admin, row.id);
      result.failed++;
    }
  }
  return result;
}

async function markFailed(admin: ReturnType<typeof createAdminClient>, id: string): Promise<void> {
  await admin
    .from("creative_skeletons")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("id", id)
    .then(() => {}, () => {});
}
