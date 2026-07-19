/**
 * ad-creative-trigger — the WRITE chokepoint for "make an ad for this product." One call takes a
 * product (+ optional audience temperature) and starts a Dahlia/Max ping-pong box session.
 *
 * Why a chokepoint: enqueuing ad generation by hand kept reaching for the WRONG job kind.
 * `kind='ad-creative'` is the cadence kind whose copy path is gated behind `DAHLIA_COPY_MODE` and,
 * when unset, silently runs the deterministic `buildMetaCopyPack` node engine (no session, no Max,
 * no LF8/Schwartz treatments) — the exact defect that put un-graded own-brand ads in the bin.
 * `kind='ad-creative-copy-author'` is the runner that FORCES the author + Max copy-QC box session
 * regardless of any flag. This SDK always enqueues the latter, so a trigger can only ever produce a
 * real Dahlia/Max creative — never a node-path ad.
 *
 * Temperature: the box session scopes its winner research + angle selection to an audience
 * temperature (cold prospecting vs warm/hot). The runner (`runAdCreativeCopyAuthorJob`) reads the
 * `temperature` field off the instructions and threads it as the `CreativeIntent` into
 * `runAdCreativeLoop` → `stockProduct`. Omitted ⇒ `cold` (the bin's `test-to-find-winner` default).
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The three audience temperatures a test creative can target (mirrors `CreativeIntent`). */
export type AdAudienceTemperature = "cold" | "warm" | "hot";

/** The kind that FORCES the Dahlia/Max box session — the only kind this SDK ever enqueues. */
export const AD_CREATIVE_SESSION_KIND = "ad-creative-copy-author" as const;

export interface TriggerAdGenerationInput {
  workspaceId: string;
  productId: string;
  /** Audience temperature to research + author for. Default `cold` (test-to-find-winner). */
  temperature?: AdAudienceTemperature;
  /** How many creatives to author this run. Default 1 (Dahlia authors one at a time). */
  count?: number;
  /** Optional provenance note stamped on the job instructions (e.g. "ceo-manual-guru-focus"). */
  reason?: string;
}

/** The instructions JSON the box-session runner consumes. `temperature` is the field
 *  `runAdCreativeCopyAuthorJob` reads to build the `CreativeIntent`. */
export interface AdGenerationInstructions {
  product_id: string;
  count: number;
  temperature: AdAudienceTemperature;
  trigger_reason?: string;
}

export interface TriggerAdGenerationResult {
  jobId: string;
  kind: typeof AD_CREATIVE_SESSION_KIND;
  productId: string;
  temperature: AdAudienceTemperature;
  count: number;
}

/** PURE — build the instructions payload for a box-session ad-generation job. Exported + unit-tested
 *  so the shape the runner depends on is pinned without a DB. Defaults: temperature `cold`, count 1. */
export function buildAdGenerationInstructions(
  input: Pick<TriggerAdGenerationInput, "productId" | "temperature" | "count" | "reason">,
): AdGenerationInstructions {
  const instr: AdGenerationInstructions = {
    product_id: input.productId,
    count: input.count ?? 1,
    temperature: input.temperature ?? "cold",
  };
  if (input.reason) instr.trigger_reason = input.reason;
  return instr;
}

/**
 * Trigger one Dahlia/Max box-session ad generation for a product at a given audience temperature.
 * Enqueues a `kind='ad-creative-copy-author'` agent_jobs row (box-session-only) and returns the
 * job id. Read the produced ad back with `ads-read-sdk` `traceAdOrigin` to confirm it ran through
 * the session (author self-score present, Max graded, treatments applied).
 *
 * This is a manual/explicit trigger: it does NOT consult the ad-creative kill switch (a human asking
 * for one ad is not the autonomous cadence). Cadence-side freeze enforcement lives in the cadence.
 */
export async function triggerAdGeneration(
  admin: Admin,
  input: TriggerAdGenerationInput,
): Promise<TriggerAdGenerationResult> {
  if (!input.productId) throw new Error("triggerAdGeneration: productId is required");
  const instr = buildAdGenerationInstructions(input);
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: input.workspaceId,
      kind: AD_CREATIVE_SESSION_KIND,
      status: "queued",
      spec_slug: `${AD_CREATIVE_SESSION_KIND}:${input.productId}`,
      instructions: JSON.stringify(instr),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`triggerAdGeneration: ${error?.message ?? "insert returned no row"}`);
  return {
    jobId: (data as { id: string }).id,
    kind: AD_CREATIVE_SESSION_KIND,
    productId: input.productId,
    temperature: instr.temperature,
    count: instr.count,
  };
}
