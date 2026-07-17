/**
 * ad-copy-variants — the SDK chokepoint for `public.ad_creative_copy_variants`. The temperature-
 * banded per-creative pack (dahlia-temperature-banded-multi-variant-copy-pack Phase 1) is written
 * ONLY through `writeCopyVariants` — raw `.from("ad_creative_copy_variants").insert/upsert(...)`
 * anywhere in `src/` is a CLAUDE.md 'raw .from(...) with no SDK → STOP' violation and the
 * `_check-*-sdk-compliance` predeploy guard would fail on a follow-up spec.
 *
 * The helper batches an UPSERT on the UNIQUE (ad_campaign_id, audience_temperature) constraint so
 * re-running the same pack write (e.g. Phase 2's per-variant revise landing ONLY the cold band
 * on a second pass) is idempotent — no duplicate rows, no manual delete-then-insert. Empty
 * variants[] → zero rows, no throw (the caller may narrow the pack via target_temperatures).
 *
 * Not a writer for `ad_campaigns` — the CANONICAL variant is stamped there by `insertReadyCreative`
 * via `pickCanonicalVariant`; this SDK only touches the sibling table. Split into its own module
 * (rather than living inside creative-agent.ts) so the tests + the future publisher-asset-feed
 * reader can import the writer without pulling the whole ad-creative loop.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { AuthorModeCopyVariant } from "./creative-agent";

type Admin = ReturnType<typeof createAdminClient>;

/** Options for `writeCopyVariants`. `variants` is the full pack for ONE creative; the SDK writes
 *  one row per entry. The caller is responsible for having already stamped the CANONICAL variant
 *  on the parent `ad_campaigns` row (via `insertReadyCreative`), so a downstream single-caption
 *  reader still works if it ignores this table entirely. */
export interface WriteCopyVariantsOpts {
  adCampaignId: string;
  workspaceId: string;
  variants: readonly AuthorModeCopyVariant[];
}

export interface WriteCopyVariantsResult {
  /** Number of rows the upsert affected. `0` when `variants` was empty. */
  inserted: number;
}

/** Persist a temperature-banded pack to `ad_creative_copy_variants`. Idempotent by design:
 *  the upsert targets the UNIQUE (ad_campaign_id, audience_temperature) constraint, so writing
 *  the same pack twice yields the same rows (Phase 2's per-variant revise that lands ONLY the
 *  cold band on a re-run overwrites the cold row rather than piling up drafts).
 *
 *  Fails LOUDLY on a driver-level error (throws) — a silent skip would erase the audit trail the
 *  spec's success metric depends on. An empty `variants` array is a valid no-op (returns
 *  `{inserted:0}`). */
export async function writeCopyVariants(
  admin: Admin,
  opts: WriteCopyVariantsOpts,
): Promise<WriteCopyVariantsResult> {
  const { adCampaignId, workspaceId, variants } = opts;
  if (!variants.length) return { inserted: 0 };
  const rows = variants.map((v) => ({
    workspace_id: workspaceId,
    ad_campaign_id: adCampaignId,
    audience_temperature: v.audience_temperature,
    headline: v.headline,
    primary_text: v.primaryText,
    description: v.description,
    author_self_score: v.selfScore,
    claim_trace: v.claim_trace,
    validator_pass: v.validatorPass,
    validator_checks: v.validatorChecks,
    concept_tag: v.concept_tag,
    retry_index: typeof v.retryIndex === "number" ? v.retryIndex : 0,
  }));
  const { data, error } = await admin
    .from("ad_creative_copy_variants")
    .upsert(rows, { onConflict: "ad_campaign_id,audience_temperature" })
    .select("id");
  if (error) {
    throw new Error(
      `writeCopyVariants: upsert failed for ad_campaign_id=${adCampaignId}: ${error.message ?? String(error)}`,
    );
  }
  return { inserted: (data ?? []).length };
}
