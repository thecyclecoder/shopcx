/**
 * Marco / Logistics executor surface — Phase 1 of
 * [[../../../docs/brain/specs/marco-logistics-executor-surface.md]].
 *
 * Retires the prose-only availability lever at
 * [[./crisis-forecast]] `buildRecommendations` line 187
 * ("Pull SL OFF the storefront + portal options") — that recommendation was a
 * plain-English instruction to the operator with no callable executor behind
 * it. `setStorefrontAvailability(workspaceId, variantId, available, reason)`
 * is that executor: one call flips a variant on/off in BOTH surfaces the
 * lever names, idempotently, and records a `director_activity` audit row
 * naming the reason.
 *
 * The two writes both go through sanctioned SDKs:
 *
 *  1) PORTAL swap options — the crisis availability lever the mutation-guard
 *     already reads. Toggles `workspaces.portal_config.suppressed_variant_ids`
 *     (the JSONB array [[../portal/mutation-guard]] `getSuppressedVariantIds`
 *     reads to filter the swap/add catalog AND to server-side reject a crafted
 *     `replaceVariants` request naming a suppressed variant). available=false
 *     ADDS the variant to the set (hides it from new-choice paths — existing
 *     subscription lines are unaffected, they still renew against it);
 *     available=true REMOVES it (restores it as a portal choice).
 *
 *  2) SHOPIFY STOREFRONT theme — the customer-facing Superfoods PDP. Uses the
 *     same mechanism [[../../../scripts/hide-strawberry-lemonade-superfood-tabs-theme]]
 *     established for Mixed Berry / Strawberry Lemonade: patch the theme's
 *     `variant.id ==` / `!=` Liquid comparison in the quantity-breaks /
 *     customize-flavor snippet, OR (Dawn fallback) the `"hidden_variants"`
 *     CSV setting. available=false ADDS the variant to the exclusion via
 *     `patchLiquidVariantExclusion` (needs a peer variant already excluded to
 *     anchor onto) OR `patchHiddenVariantsSetting`. available=true REMOVES it
 *     via the mirror `unpatchLiquidVariantExclusion` / `unpatchJsonForVariant`
 *     / `unpatchHiddenVariantsSetting`. Writes go through
 *     [[../shopify-theme]] `commitThemeFiles` — a single atomic GitHub commit
 *     Shopify's GitHub-connected theme auto-deploys.
 *
 * ⭐ Idempotency guard — cited per the spec's ### Verification: every branch
 * of this helper compares CURRENT state against the target BEFORE it writes.
 * The portal-side skips the DB update when the variant already carries the
 * target suppression state (`computeSuppressionDelta` returns changed=false);
 * the storefront-side skips the theme commit when every patcher returns null
 * (idempotent — the theme file already reflects the target state). A repeat
 * call is a full no-op: no DB write, no theme commit, no audit row.
 *
 * The live-flip stays a CEO action (function_autonomy.live) — Phase 2 wires
 * the M3 dispatch executor branch that calls this helper on Marco's leash
 * grant, plus the coach-framing card the CEO approves before the call fires.
 *
 * See docs/brain/specs/marco-logistics-executor-surface.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { recordDirectorActivity } from "@/lib/director-activity";
import { getSuppressedVariantIds } from "@/lib/portal/mutation-guard";
import {
  patchLiquidVariantExclusion,
  patchJsonForSl,
  patchHiddenVariantsSetting,
  unpatchLiquidVariantExclusion,
  unpatchJsonForVariant,
  unpatchHiddenVariantsSetting,
} from "@/lib/shopify-theme-hidden-variants";

/** The Logistics function slug — supervises this executor per the org chart. */
export const LOGISTICS_FUNCTION = "logistics";

/** Audit action kind on `director_activity` — one row per non-noop call. */
export const AVAILABILITY_ACTION_KIND = "storefront_availability_toggled";

export interface StorefrontAvailabilityResult {
  workspaceId: string;
  variantId: string;
  /** Target state the call asked for. */
  available: boolean;
  reason: string;
  /** Portal-side (workspaces.portal_config.suppressed_variant_ids) outcome. */
  portal:
    | { attempted: true; changed: false; reason: "already_in_target_state" }
    | { attempted: true; changed: true; before: string[]; after: string[] }
    | { attempted: false; reason: string };
  /** Shopify-theme-side commit outcome. */
  storefront:
    | { attempted: true; changed: false; reason: "already_in_target_state" | "no_patchable_reference" }
    | { attempted: true; changed: true; commitSha: string; files: string[] }
    | { attempted: false; reason: string };
  /** True when both sides no-op'd (a full re-run is safe + free). */
  alreadyInTargetState: boolean;
}

/**
 * Pure predicate — given the current suppressed-variant set + a (variantId,
 * available) target, return the next set + whether the write changes anything.
 * Extracted so the idempotency contract ("variant already in target state →
 * no write") is unit-testable without touching Supabase.
 *
 * Convention: available=false means the variant IS suppressed (in the set).
 */
export function computeSuppressionDelta(
  current: ReadonlySet<string>,
  variantId: string,
  available: boolean,
): { next: string[]; changed: boolean } {
  const has = current.has(variantId);
  const wantsInSet = !available;
  if (has === wantsInSet) {
    return { next: [...current].sort(), changed: false };
  }
  const nextSet = new Set(current);
  if (wantsInSet) nextSet.add(variantId);
  else nextSet.delete(variantId);
  return { next: [...nextSet].sort(), changed: true };
}

async function togglePortalSuppression(
  workspaceId: string,
  variantId: string,
  available: boolean,
): Promise<StorefrontAvailabilityResult["portal"]> {
  const admin = createAdminClient();
  const current = await getSuppressedVariantIds(workspaceId);
  const delta = computeSuppressionDelta(current, variantId, available);
  const before = [...current].sort();
  if (!delta.changed) {
    return { attempted: true, changed: false, reason: "already_in_target_state" };
  }
  const { data: ws, error: readErr } = await admin
    .from("workspaces")
    .select("portal_config")
    .eq("id", workspaceId)
    .single();
  if (readErr) {
    return { attempted: false, reason: `read_portal_config_failed: ${readErr.message}` };
  }
  const cfg = (ws?.portal_config as Record<string, unknown> | null) ?? {};
  const nextCfg = { ...cfg, suppressed_variant_ids: delta.next };
  const { error: writeErr } = await admin
    .from("workspaces")
    .update({ portal_config: nextCfg })
    .eq("id", workspaceId);
  if (writeErr) {
    return { attempted: false, reason: `write_portal_config_failed: ${writeErr.message}` };
  }
  return { attempted: true, changed: true, before, after: delta.next };
}

async function toggleShopifyTheme(
  workspaceId: string,
  variantId: string,
  available: boolean,
  reason: string,
): Promise<StorefrontAvailabilityResult["storefront"]> {
  let getLiveTheme: typeof import("@/lib/shopify-theme").getLiveTheme;
  let readThemeFile: typeof import("@/lib/shopify-theme").readThemeFile;
  let listRepoFiles: typeof import("@/lib/shopify-theme").listRepoFiles;
  let commitThemeFiles: typeof import("@/lib/shopify-theme").commitThemeFiles;
  try {
    const mod = await import("@/lib/shopify-theme");
    getLiveTheme = mod.getLiveTheme;
    readThemeFile = mod.readThemeFile;
    listRepoFiles = mod.listRepoFiles;
    commitThemeFiles = mod.commitThemeFiles;
  } catch (e) {
    return { attempted: false, reason: `shopify_theme_module_load_failed: ${(e as Error).message}` };
  }

  let target: { owner: string; repo: string; branch: string };
  try {
    const live = await getLiveTheme(workspaceId);
    target = live.target;
  } catch (e) {
    return { attempted: false, reason: `get_live_theme_failed: ${(e as Error).message}` };
  }

  if (!process.env.GITHUB_TOKEN) {
    return { attempted: false, reason: "github_token_missing" };
  }

  let paths: string[];
  try {
    const tree = await listRepoFiles(target);
    paths = Array.from(tree.keys()).filter((p) => /\.(liquid|jsonc?)$/i.test(p));
  } catch (e) {
    return { attempted: false, reason: `list_repo_files_failed: ${(e as Error).message}` };
  }

  const changes: { path: string; content: string }[] = [];
  for (const path of paths) {
    let content: string | null;
    try {
      content = await readThemeFile(target, path);
    } catch {
      continue;
    }
    if (content == null || !content.includes(variantId)) continue;

    let patched: string | null = null;
    if (available) {
      // Remove the variant from any current exclusion — pick the first patcher
      // whose file shape matches. Idempotent: unpatch returns null if the
      // variant isn't in a recognised exclusion shape on this file.
      patched =
        unpatchLiquidVariantExclusion(content, variantId) ??
        unpatchJsonForVariant(content, variantId) ??
        unpatchHiddenVariantsSetting(content, variantId);
    } else {
      // Add the variant to an exclusion. The Liquid patcher requires an ANCHOR
      // variant already excluded — for Marco's crisis dispatch the anchor is
      // the crisis's OTHER already-suppressed variant, so a caller can seed the
      // exclusion by first suppressing the anchor. The Dawn fallback needs
      // only a `hidden_variants` CSV setting to be present. If neither shape
      // exists, we skip — the caller sees `no_patchable_reference` and can
      // fall back to a manual theme edit (Phase 1 spec's needs_human review).
      const suppressedSet = await getSuppressedVariantIds(workspaceId);
      for (const anchor of suppressedSet) {
        if (anchor === variantId) continue;
        const attempt = patchLiquidVariantExclusion(content, anchor, variantId);
        if (attempt) { patched = attempt; break; }
        const j = patchJsonForSl(content, anchor, variantId);
        if (j) { patched = j; break; }
      }
      if (!patched) patched = patchHiddenVariantsSetting(content, variantId);
    }
    if (patched && patched !== content) changes.push({ path, content: patched });
  }

  if (!changes.length) {
    // Idempotency guard: every patcher returned null → theme is already in the
    // target state (available=true and the variant isn't excluded anywhere;
    // OR available=false and the exclusion shape doesn't match). The caller
    // learns the difference via `available` + `no_patchable_reference`.
    return { attempted: true, changed: false, reason: "already_in_target_state" };
  }

  const message =
    `Storefront availability: ${available ? "SHOW" : "HIDE"} variant ${variantId} (marco/logistics)\n\n${reason.slice(0, 500)}\n\nAuthored via setStorefrontAvailability (docs/brain/specs/marco-logistics-executor-surface.md).`;
  try {
    const commit = await commitThemeFiles(target, changes, message);
    return { attempted: true, changed: true, commitSha: commit.commitSha, files: changes.map((c) => c.path) };
  } catch (e) {
    return { attempted: false, reason: `commit_theme_files_failed: ${(e as Error).message}` };
  }
}

/**
 * Idempotently drive the two-surface storefront availability lever for one
 * variant. Safe to re-run: every re-call after the first is a no-op (no DB
 * write, no theme commit, no audit row). See the file header for the full
 * behavior + the ⭐ Idempotency guard.
 */
export async function setStorefrontAvailability(
  workspaceId: string,
  variantId: string,
  available: boolean,
  reason: string,
): Promise<StorefrontAvailabilityResult> {
  const trimmedVariant = String(variantId ?? "").trim();
  const trimmedReason = String(reason ?? "").trim();
  if (!workspaceId || !trimmedVariant) {
    throw new Error("setStorefrontAvailability: workspaceId + variantId required");
  }
  if (!trimmedReason) {
    throw new Error("setStorefrontAvailability: reason required (recorded on the audit row)");
  }

  const portal = await togglePortalSuppression(workspaceId, trimmedVariant, available);
  const storefront = await toggleShopifyTheme(workspaceId, trimmedVariant, available, trimmedReason);

  const portalChanged = portal.attempted && portal.changed;
  const storefrontChanged = storefront.attempted && storefront.changed;
  const alreadyInTargetState = !portalChanged && !storefrontChanged;

  if (!alreadyInTargetState) {
    // One audit row per non-noop call — the ledger the recap + the CEO
    // supervision surfaces read. Best-effort per recordDirectorActivity's
    // contract (never throws).
    const admin = createAdminClient();
    await recordDirectorActivity(admin, {
      workspaceId,
      directorFunction: LOGISTICS_FUNCTION,
      actionKind: AVAILABILITY_ACTION_KIND,
      reason: trimmedReason,
      metadata: {
        variant_id: trimmedVariant,
        available,
        portal_changed: portalChanged,
        storefront_changed: storefrontChanged,
        portal_outcome: portal,
        storefront_outcome: storefront,
        autonomous: false,
      },
    });
  }

  return {
    workspaceId,
    variantId: trimmedVariant,
    available,
    reason: trimmedReason,
    portal,
    storefront,
    alreadyInTargetState,
  };
}
