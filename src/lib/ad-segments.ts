/**
 * Ad tool — creative library: per-piece persistence + the stitch recipe.
 *
 * Every generated piece (each talking-head Veo segment with the script that made
 * it, each b-roll clip, the music bed) is recorded as an `ad_segments` row, and
 * the assembly is stored as `ad_campaigns.composition`. That's what makes the
 * re-launch flow possible: "refresh the hook, redo ONE segment, re-stitch" =
 * regenerate one segment row (version+1) and re-render from the recipe — every
 * other piece is reused, nothing re-burned.
 *
 * Split between PURE planning (script→segments, segments→composition; testable,
 * no deps) and DB helpers (admin client). See docs/brain/tables/ad_segments.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { TranscriptWord } from "@/lib/ad-transcribe";

export type SegmentKind = "talking_head" | "broll" | "music";

export interface AdSegment {
  id: string;
  workspace_id: string;
  campaign_id: string;
  kind: SegmentKind;
  seq: number;
  version: number;
  is_active: boolean;
  script_text: string | null;
  prompt: string | null;
  model: string | null;
  storage_path: string | null;
  source_url: string | null; // input image for image-to-video (b-roll still)
  duration_sec: number | null;
  trim_sec: number | null;
  transcript_json: { words: TranscriptWord[] } | null;
  status: "generating" | "ready" | "failed";
  error: string | null;
  created_at: string;
}

// ── The stitch recipe (stored on ad_campaigns.composition) ──────────────────

export interface Composition {
  /** base VO talking layer, in playback order (audio = the continuous VO spine) */
  segments: { segment_id: string; startSec: number; trimSec: number }[];
  /** muted/ASMR b-roll cutaways laid over the talking layer */
  broll: { segment_id: string; fromSec: number; durSec: number; volume: number }[];
  /** one low music bed under everything */
  music: { segment_id: string; volume: number } | null;
  durationSec: number;
  fps: number;
}

// ── PURE: split a full script into per-Veo-segment scripts ──────────────────

/**
 * Veo clips top out around ~8s, so a 15s ad needs ~2 talking segments and a 30s
 * ad ~4. Split the campaign script into that many chunks on sentence boundaries,
 * balancing word counts so each clip lands near (but under) the cap. Each chunk
 * becomes one talking-head segment with its own "say ONLY these words" prompt.
 */
export function splitScriptIntoSegments(script: string, lengthSec: number): string[] {
  const clean = (script || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [clean];
  const target = lengthSec >= 30 ? 4 : lengthSec >= 22 ? 3 : 2;
  if (sentences.length <= target) return sentences;

  const totalWords = sentences.reduce((n, s) => n + s.split(" ").length, 0);
  const ideal = totalWords / target;
  const buckets: string[][] = [];
  let cur: string[] = [];
  let curWords = 0;
  for (const s of sentences) {
    const w = s.split(" ").length;
    // close the current bucket once it's full enough AND we still need to leave
    // at least one sentence for each remaining bucket.
    const remainingSentencesAfter = sentences.length - (buckets.flat().length + cur.length + 1);
    const bucketsLeftToOpen = target - buckets.length - 1;
    if (cur.length && curWords + w > ideal * 1.15 && remainingSentencesAfter >= bucketsLeftToOpen && bucketsLeftToOpen > 0) {
      buckets.push(cur);
      cur = [];
      curWords = 0;
    }
    cur.push(s);
    curWords += w;
  }
  if (cur.length) buckets.push(cur);
  return buckets.map((b) => b.join(" "));
}

// ── PURE: assemble the composition from active segments ─────────────────────

/**
 * Build the stitch recipe from the active pieces. Talking segments form the base
 * VO layer back-to-back (each cut at its trim point). B-roll clips are laid over
 * the tail of successive talking segments as ducked cutaways. Music spans all.
 */
export function buildComposition(
  talking: Pick<AdSegment, "id" | "seq" | "trim_sec" | "duration_sec">[],
  broll: Pick<AdSegment, "id" | "seq" | "duration_sec">[],
  music: Pick<AdSegment, "id"> | null,
  fps = 30,
): Composition {
  const th = [...talking].sort((a, b) => a.seq - b.seq);
  let acc = 0;
  const segments = th.map((s) => {
    const trimSec = Number(s.trim_sec ?? s.duration_sec ?? 8);
    const startSec = acc;
    acc += trimSec;
    return { segment_id: s.id, startSec, trimSec };
  });
  const durationSec = acc;

  // Distribute b-roll over the tail of talking segments (skip the first so the
  // hook lands on the talking head; never overlay the very last CTA frames).
  const bclips = [...broll].sort((a, b) => a.seq - b.seq);
  const overlays: Composition["broll"] = [];
  for (let i = 0; i < bclips.length; i++) {
    const host = segments[Math.min(i + 1, segments.length - 1)];
    if (!host) break;
    const durSec = Math.min(2.4, Number(bclips[i].duration_sec ?? 2.4), host.trimSec * 0.7);
    const fromSec = Math.max(host.startSec, host.startSec + host.trimSec - durSec - 0.2);
    if (fromSec + durSec > durationSec - 0.3) continue; // keep the CTA clean
    overlays.push({ segment_id: bclips[i].id, fromSec, durSec, volume: 0.18 });
  }

  return {
    segments,
    broll: overlays,
    music: music ? { segment_id: music.id, volume: 0.12 } : null,
    durationSec,
    fps,
  };
}

// ── DB helpers ──────────────────────────────────────────────────────────────

export interface NewSegment {
  workspaceId: string;
  campaignId: string;
  kind: SegmentKind;
  seq: number;
  scriptText?: string | null;
  prompt?: string | null;
  model?: string | null;
  sourceUrl?: string | null;
}

/** Insert a 'generating' segment row; returns its id. */
export async function createSegment(s: NewSegment): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ad_segments")
    .insert({
      workspace_id: s.workspaceId,
      campaign_id: s.campaignId,
      kind: s.kind,
      seq: s.seq,
      script_text: s.scriptText ?? null,
      prompt: s.prompt ?? null,
      model: s.model ?? null,
      source_url: s.sourceUrl ?? null,
      status: "generating",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`ad_segment_insert: ${error?.message || "no_row"}`);
  return data.id;
}

export interface SegmentResult {
  storagePath: string;
  durationSec?: number;
  trimSec?: number;
  transcript?: { words: TranscriptWord[] };
}

/** Mark a segment ready with its rendered output + timing. */
export async function completeSegment(id: string, r: SegmentResult): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("ad_segments")
    .update({
      storage_path: r.storagePath,
      duration_sec: r.durationSec ?? null,
      trim_sec: r.trimSec ?? null,
      transcript_json: r.transcript ?? null,
      status: "ready",
    })
    .eq("id", id);
}

export async function failSegment(id: string, error: string): Promise<void> {
  const admin = createAdminClient();
  await admin.from("ad_segments").update({ status: "failed", error }).eq("id", id);
}

/** Active, ready segments for a campaign, grouped by kind, ordered by seq. */
export async function loadActiveSegments(campaignId: string): Promise<{
  talking: AdSegment[];
  broll: AdSegment[];
  music: AdSegment | null;
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("ad_segments")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("is_active", true)
    .eq("status", "ready")
    .order("seq", { ascending: true });
  const rows = (data || []) as AdSegment[];
  return {
    talking: rows.filter((r) => r.kind === "talking_head"),
    broll: rows.filter((r) => r.kind === "broll"),
    music: rows.find((r) => r.kind === "music") || null,
  };
}

/**
 * Begin regenerating ONE segment (talking_head or broll): deactivate the current
 * active row at (campaign, kind, seq) and insert a fresh 'generating' row at
 * version+1. Carries over script/prompt/source unless overridden, so the same
 * content can be re-rendered with a different model (e.g. HQ Veo 3). Returns the
 * new row id. Re-render after it completes to re-stitch.
 */
export async function regenerateSegment(args: {
  workspaceId: string;
  campaignId: string;
  kind: SegmentKind;
  seq: number;
  scriptText?: string | null;
  prompt?: string | null;
  model?: string | null;
  sourceUrl?: string | null;
}): Promise<string> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("ad_segments")
    .select("version")
    .eq("campaign_id", args.campaignId)
    .eq("kind", args.kind)
    .eq("seq", args.seq)
    .eq("is_active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = (existing?.version ?? 0) + 1;
  await admin
    .from("ad_segments")
    .update({ is_active: false })
    .eq("campaign_id", args.campaignId)
    .eq("kind", args.kind)
    .eq("seq", args.seq);
  const { data, error } = await admin
    .from("ad_segments")
    .insert({
      workspace_id: args.workspaceId,
      campaign_id: args.campaignId,
      kind: args.kind,
      seq: args.seq,
      version: nextVersion,
      is_active: true,
      script_text: args.scriptText ?? null,
      prompt: args.prompt ?? null,
      model: args.model ?? null,
      source_url: args.sourceUrl ?? null,
      status: "generating",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`ad_segment_regen: ${error?.message || "no_row"}`);
  return data.id;
}

/** Persist the stitch recipe on the campaign. */
export async function saveComposition(campaignId: string, composition: Composition): Promise<void> {
  const admin = createAdminClient();
  await admin.from("ad_campaigns").update({ composition }).eq("id", campaignId);
}
