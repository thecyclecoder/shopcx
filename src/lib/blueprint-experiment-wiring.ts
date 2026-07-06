/**
 * Baseline [[storefront_experiments]] wiring for a shipped
 * [[lander_blueprints]] row — Phase 2 of the "build the {slug} lander" spec
 * chain. Stands up the campaign shell (status='draft', single control arm,
 * no explore arms) so the storefront-optimizer + campaign-grader see the new
 * lander as a candidate surface. The row is NOT serving traffic yet — the
 * founder promotes it to `running` once the render QA passes (Phase 3).
 *
 * The single write here is idempotent at the surface grain
 * `(workspace_id, product_id, lander_type, lever='blueprint-baseline')` — a
 * re-run against an already-wired blueprint returns the existing row instead
 * of inserting a duplicate. That lets the Phase-2 apply script re-run cheaply
 * without a compare-and-set gymnastics dance (the grain is unique enough by
 * design: one blueprint per (workspace, product, funnel_type) → one baseline
 * row per (workspace, product, lander_type)).
 *
 * Round-trip visibility (spec Phase 2, bullet 3): the inserted
 * `last_decision` jsonb carries the source blueprint's id + its
 * `build_spec_slug`, so a reader on either side (blueprint or experiment) can
 * pivot to the other without a second query. `lander_blueprints.build_spec_slug`
 * is already set by [[blueprint-build-submit]] — this file only READS the
 * blueprint (to name the row); it never writes back.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { LanderBlueprint } from "@/lib/lander-blueprints";
import {
  mapFunnelTypeToLanderType,
  type StorefrontLanderType,
} from "@/lib/cleo-blueprint";

export interface WireBlueprintExperimentInput {
  workspaceId: string;
  blueprintId: string;
  /** Author of the row — 'lander-build-<slug>' script name, or an operator email. */
  createdBy?: string | null;
}

export type WireBlueprintOutcome =
  | {
      ok: true;
      experimentId: string;
      landerType: StorefrontLanderType;
      /** True when a matching row already existed and was returned; false on fresh insert. */
      alreadyWired: boolean;
      detail: string;
    }
  | { ok: false; detail: string };

/** The lever key that tags a blueprint's baseline campaign row — held stable
 *  so the idempotency read finds the same row on a re-run. */
export const BLUEPRINT_BASELINE_LEVER = "blueprint-baseline";

/**
 * Insert (or return-existing) the baseline campaign row for a blueprint.
 *
 * Steps:
 *   1. Load the blueprint by `(workspace_id, id)` — reject if the row is
 *      missing, not in this workspace, or its content isn't filled (a
 *      baseline row for an unfilled blueprint would let the render 200
 *      before Carrie's copy exists).
 *   2. Map `funnel_type → lander_type` via [[cleo-blueprint]] `mapFunnelTypeToLanderType`.
 *      Reject when the funnel_type doesn't map (no lander_type = no bandit
 *      surface = nothing to wire).
 *   3. Idempotency read on `(workspace_id, product_id, lander_type, lever=BLUEPRINT_BASELINE_LEVER)`.
 *      Match → return the existing row's id. Miss → insert.
 *   4. Insert the experiment row + a single control arm (empty patch). The
 *      row lands at `status='draft'` — the founder flips it to `running` from
 *      the storefront-experiments dashboard when the render QA passes; only
 *      then does the paired public URL become reachable to non-owners.
 */
export async function wireBlueprintExperiment(
  input: WireBlueprintExperimentInput,
): Promise<WireBlueprintOutcome> {
  const admin = createAdminClient();

  const { data: bpRow, error: bpErr } = await admin
    .from("lander_blueprints")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("id", input.blueprintId)
    .maybeSingle();
  if (bpErr) return { ok: false, detail: `blueprint read failed: ${bpErr.message}` };
  const blueprint = bpRow as LanderBlueprint | null;
  if (!blueprint) {
    return { ok: false, detail: `blueprint ${input.blueprintId} not found in workspace ${input.workspaceId}` };
  }
  if (!blueprint.content || !Array.isArray(blueprint.content.blocks) || blueprint.content.blocks.length === 0) {
    return {
      ok: false,
      detail: `blueprint ${blueprint.id} has no content.blocks — Carrie hasn't filled it; refusing to wire a baseline row that would 200 an empty lander`,
    };
  }

  const landerType = mapFunnelTypeToLanderType(blueprint.funnel_type);
  if (!landerType) {
    return {
      ok: false,
      detail: `blueprint funnel_type='${blueprint.funnel_type}' doesn't map to a known lander_type (pdp|listicle|beforeafter|advertorial) — nothing to wire`,
    };
  }

  const { data: existing } = await admin
    .from("storefront_experiments")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("product_id", blueprint.product_id)
    .eq("lander_type", landerType)
    .eq("lever", BLUEPRINT_BASELINE_LEVER)
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    return {
      ok: true,
      experimentId: existing.id as string,
      landerType,
      alreadyWired: true,
      detail: `blueprint ${blueprint.id} already wired: storefront_experiments ${existing.id} (${landerType}, lever=${BLUEPRINT_BASELINE_LEVER})`,
    };
  }

  const nowIso = new Date().toISOString();
  const hypothesis = `Cleo's ${blueprint.funnel_type} blueprint (id=${blueprint.id}) rendered as an addressable ${landerType} lander for product ${blueprint.product_id}. Baseline campaign — no explore arms yet; the founder promotes to 'running' when the render QA passes (Phase 3 of the paired build spec).`;

  const { data: expRow, error: expErr } = await admin
    .from("storefront_experiments")
    .insert({
      workspace_id: input.workspaceId,
      product_id: blueprint.product_id,
      lander_type: landerType,
      audience: "all",
      lever: BLUEPRINT_BASELINE_LEVER,
      hypothesis,
      status: "draft",
      holdout_pct: 0.1,
      created_by: null,
      last_decision: {
        action: "blueprint_wired",
        by: input.createdBy ?? "wire-blueprint-experiment",
        blueprint_id: blueprint.id,
        build_spec_slug: blueprint.build_spec_slug,
        funnel_type: blueprint.funnel_type,
        at: nowIso,
      },
    })
    .select("id")
    .single();
  if (expErr || !expRow) {
    return { ok: false, detail: `storefront_experiments insert failed: ${expErr?.message ?? "no row"}` };
  }
  const experimentId = expRow.id as string;

  const { error: varErr } = await admin.from("storefront_experiment_variants").insert({
    experiment_id: experimentId,
    workspace_id: input.workspaceId,
    label: "control",
    is_control: true,
    patch: {},
  });
  if (varErr) {
    await admin
      .from("storefront_experiments")
      .delete()
      .eq("id", experimentId)
      .eq("workspace_id", input.workspaceId);
    return {
      ok: false,
      detail: `control-arm insert failed (experiment ${experimentId} rolled back): ${varErr.message}`,
    };
  }

  return {
    ok: true,
    experimentId,
    landerType,
    alreadyWired: false,
    detail: `wired blueprint ${blueprint.id} → storefront_experiments ${experimentId} (${landerType}, lever=${BLUEPRINT_BASELINE_LEVER}, status=draft) with a single control arm`,
  };
}
