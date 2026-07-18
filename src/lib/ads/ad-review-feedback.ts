/**
 * ad-review-feedback — SDK chokepoint for `public.ad_review_feedback` (Phase 1 of
 * ceo-manual-ad-review-inline-per-element-feedback-routed-to-dahlia-max-render). The ad
 * detail page's annotation UI submits a per-element feedback packet (only non-empty
 * comments) that is persisted here, and Phase 2's dispatcher reads it to route each
 * entry to the owning lane. Raw `.from("ad_review_feedback").insert(...)` from a route
 * would violate the CLAUDE.md 'raw .from(...) with no SDK → STOP' rule and skip the
 * shape validation `parseAdReviewFeedbackPacket` runs before every write.
 *
 * The packet's `entries[]` are typed by target — the API and the SDK narrow the union
 * so a downstream reader can `switch` exhaustively on `targetKind` without a wider cast.
 * Phase 1 is UI + persistence only; the dispatcher + `routeAdReviewFeedback` land in
 * Phase 2.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The 5 conversion-psychology frameworks Dahlia's per-framework copy variations lead
 *  with (mirror of `AUTHOR_FRAMEWORK_KEYS` in `creative-agent.ts`). A `copy-variation`
 *  packet entry that references one of these names the specific variation to revise. */
export const AD_REVIEW_FRAMEWORK_KEYS = ["lf8", "schwartz", "cialdini", "hopkins", "sugarman"] as const;
export type AdReviewFramework = (typeof AD_REVIEW_FRAMEWORK_KEYS)[number];

/** Meta placement format keys — the 4 static renders a Dahlia pack produces
 *  (feed_4x5 · stories_9x16 · reels_9x16 · right_column_1x1). A `render-format`
 *  entry names EXACTLY one so Phase 2's regenerate lane knows which image to redo. */
export const AD_REVIEW_RENDER_FORMATS = [
  "feed_4x5",
  "stories_9x16",
  "reels_9x16",
  "right_column_1x1",
] as const;
export type AdReviewRenderFormat = (typeof AD_REVIEW_RENDER_FORMATS)[number];

/** One entry in an AdReviewFeedbackPacket — every reviewable element on the ad detail
 *  page maps to one of these targets. Empty comments never make it into the packet
 *  (the UI filters at build time; the parser rejects at write time). */
export type AdReviewFeedbackEntry =
  | { targetKind: "render-format"; format: AdReviewRenderFormat; comment: string }
  | { targetKind: "copy-variation"; framework: AdReviewFramework; comment: string }
  | { targetKind: "canonical-copy"; comment: string }
  | { targetKind: "max-grade"; comment: string };

/** The full submit payload — one packet per Submit click, with only the non-empty comments. */
export interface AdReviewFeedbackPacket {
  entries: AdReviewFeedbackEntry[];
}

/** Cap on a single comment's length. A reviewer note is a short surgical critique,
 *  not an essay — the shape gate here matches Meta's own headline/primary-text caps
 *  in spirit (short is better; long is a smell the reviewer should split into
 *  multiple targeted comments). */
export const AD_REVIEW_COMMENT_MAX_LEN = 2000;

const FRAMEWORK_SET = new Set<string>(AD_REVIEW_FRAMEWORK_KEYS);
const RENDER_FORMAT_SET = new Set<string>(AD_REVIEW_RENDER_FORMATS);

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

/** Narrow + validate an unknown value into a typed AdReviewFeedbackPacket. Rejects an
 *  empty entries[] (a Submit with no filled boxes is the API's job to short-circuit,
 *  not something we persist), a comment past the cap, an unknown targetKind, or an
 *  unknown framework/format. Throws with a specific reason so the caller can surface
 *  it — the caller decides whether to 400 or log. */
export function parseAdReviewFeedbackPacket(raw: unknown): AdReviewFeedbackPacket {
  if (!raw || typeof raw !== "object") {
    throw new Error("ad_review_feedback: packet must be an object");
  }
  const entriesRaw = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) {
    throw new Error("ad_review_feedback: packet.entries must be a non-empty array");
  }
  const entries: AdReviewFeedbackEntry[] = entriesRaw.map((e, i) => {
    if (!e || typeof e !== "object") {
      throw new Error(`ad_review_feedback: entry[${i}] must be an object`);
    }
    const rec = e as Record<string, unknown>;
    const kind = rec.targetKind;
    const comment = rec.comment;
    if (!isNonEmptyString(comment)) {
      throw new Error(`ad_review_feedback: entry[${i}].comment must be a non-empty string`);
    }
    if (comment.length > AD_REVIEW_COMMENT_MAX_LEN) {
      throw new Error(
        `ad_review_feedback: entry[${i}].comment exceeds ${AD_REVIEW_COMMENT_MAX_LEN} chars`,
      );
    }
    switch (kind) {
      case "render-format": {
        const format = rec.format;
        if (typeof format !== "string" || !RENDER_FORMAT_SET.has(format)) {
          throw new Error(
            `ad_review_feedback: entry[${i}].format must be one of ${AD_REVIEW_RENDER_FORMATS.join("|")}`,
          );
        }
        return { targetKind: "render-format", format: format as AdReviewRenderFormat, comment };
      }
      case "copy-variation": {
        const framework = rec.framework;
        if (typeof framework !== "string" || !FRAMEWORK_SET.has(framework)) {
          throw new Error(
            `ad_review_feedback: entry[${i}].framework must be one of ${AD_REVIEW_FRAMEWORK_KEYS.join("|")}`,
          );
        }
        return { targetKind: "copy-variation", framework: framework as AdReviewFramework, comment };
      }
      case "canonical-copy":
        return { targetKind: "canonical-copy", comment };
      case "max-grade":
        return { targetKind: "max-grade", comment };
      default:
        throw new Error(`ad_review_feedback: entry[${i}].targetKind is unknown (${String(kind)})`);
    }
  });
  return { entries };
}

/** Persisted row shape as returned by `getAdReviewFeedbackForCampaign` (jsonb columns
 *  are already parsed by the driver). The Phase-2 dispatcher will type its input on
 *  this shape so it can `switch (entry.targetKind)` exhaustively. */
export interface AdReviewFeedbackRow {
  id: string;
  workspace_id: string;
  ad_campaign_id: string;
  packet: AdReviewFeedbackPacket;
  status: "queued" | "processing" | "done" | "failed";
  created_by: string | null;
  created_at: string;
}

export interface InsertAdReviewFeedbackOpts {
  workspaceId: string;
  adCampaignId: string;
  packet: AdReviewFeedbackPacket;
  createdBy: string | null;
}

/** Persist a validated packet as a new `queued` row. The caller is responsible for
 *  parsing the raw request body through `parseAdReviewFeedbackPacket` first — this
 *  helper trusts its typed input and does not re-validate. Fails LOUDLY on a driver
 *  error (throws) so a route can 500 with the reason. */
export async function insertAdReviewFeedback(
  admin: Admin,
  opts: InsertAdReviewFeedbackOpts,
): Promise<AdReviewFeedbackRow> {
  const { workspaceId, adCampaignId, packet, createdBy } = opts;
  const { data, error } = await admin
    .from("ad_review_feedback")
    .insert({
      workspace_id: workspaceId,
      ad_campaign_id: adCampaignId,
      packet,
      status: "queued",
      created_by: createdBy,
    })
    .select("id, workspace_id, ad_campaign_id, packet, status, created_by, created_at")
    .single();
  if (error || !data) {
    throw new Error(
      `insertAdReviewFeedback: insert failed for ad_campaign_id=${adCampaignId}: ${error?.message ?? "no row returned"}`,
    );
  }
  return data as AdReviewFeedbackRow;
}

/** Read every feedback packet for one campaign, newest first — the ad detail page's
 *  "recent feedback" reader (Phase 1 shows submission history; Phase 2 shows dispatch
 *  status). Returns [] on empty. Throws on a driver error so a silent-empty read never
 *  masks a broken read. */
export async function getAdReviewFeedbackForCampaign(
  admin: Admin,
  opts: { workspaceId: string; adCampaignId: string },
): Promise<AdReviewFeedbackRow[]> {
  const { data, error } = await admin
    .from("ad_review_feedback")
    .select("id, workspace_id, ad_campaign_id, packet, status, created_by, created_at")
    .eq("workspace_id", opts.workspaceId)
    .eq("ad_campaign_id", opts.adCampaignId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(
      `getAdReviewFeedbackForCampaign: select failed for ad_campaign_id=${opts.adCampaignId}: ${error.message}`,
    );
  }
  return (data ?? []) as AdReviewFeedbackRow[];
}
