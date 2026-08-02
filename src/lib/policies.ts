/**
 * policies SDK — the single sanctioned read/write surface for `public.policies`.
 *
 * Every policy row has TWO halves: `internal_summary` + `rules` (what the AI obeys) and
 * `customer_summary` (what we publish on the help centre). Before this chokepoint six files
 * queried the table by hand and each repeated the active-and-not-superseded filter — a wrong
 * column name silently reads as empty and the AI proceeds without the rule (the CLAUDE.md
 * "database is the spec" failure mode). Worse, the two halves are never compared, so the
 * published cancellation summary shipped 'You can refuse the delivery when it arrives' while
 * three other active policies say the opposite and label refused packages 'absolutely, 100%
 * not eligible' for refund; a real customer was quoted the wrong half on 2026-08-02.
 *
 * This SDK is the fix. `getPolicy` / `listActivePolicies` / `getInternalRules` /
 * `updatePolicyText` are the sanctioned entry points; active-and-not-superseded filtering
 * lives INSIDE the SDK so no caller repeats it. Enforced by
 * `scripts/_check-policies-sdk-compliance.ts` (wired into `predeploy`) — any new raw
 * `.from('policies')` outside this file breaks the build.
 *
 * The agent-facing package (`getAgentPolicyPackage`, Phase 2) will read the INTERNAL half only
 * and feed both Sol (orchestrator) and June (director brief) from the same SDK, so the two
 * agents can never reason from divergent rules again.
 *
 * See [[docs/brain/tables/policies.md]] and (Phase 4) [[docs/brain/libraries/policies.md]].
 */
import { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** Row shape mirrors `public.policies`. See [[docs/brain/tables/policies.md]] § Columns. */
export interface PolicyRow {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  version: number;
  effective_at: string;
  superseded_by: string | null;
  customer_summary: string;
  internal_summary: string;
  rules: unknown[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

/** The subset every agent-facing reader wants — the INTERNAL rule-body block. */
export interface InternalPolicyRule {
  slug: string;
  name: string;
  internal_summary: string;
}

/**
 * Fetch the ACTIVE, non-superseded policy for a workspace + slug. Returns the highest-version
 * row (there is normally exactly one active row per slug; the `.order + .limit(1)` guards
 * against a stray double-active row). Returns `null` when no active policy matches.
 *
 * Callers must not read `.customer_summary` and quote it as the rule — that's the published
 * rendering, not the rule (the 2026-08-02 refuse-delivery incident). Use `internal_summary` +
 * `rules` for enforcement decisions; use {@link getPolicyCustomerFacing} when rendering to a
 * customer.
 */
export async function getPolicy(
  admin: Admin,
  workspaceId: string,
  slug: string,
): Promise<PolicyRow | null> {
  const { data, error } = await admin
    .from("policies")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`policies.getPolicy(${slug}): ${error.message}`);
  return (data as PolicyRow | null) ?? null;
}

/**
 * List every ACTIVE, non-superseded policy for a workspace, ordered by slug. Full rows — use
 * {@link getInternalRules} when you only need the `{slug,name,internal_summary}` projection.
 */
export async function listActivePolicies(
  admin: Admin,
  workspaceId: string,
): Promise<PolicyRow[]> {
  const { data, error } = await admin
    .from("policies")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("slug");
  if (error) throw new Error(`policies.listActivePolicies: ${error.message}`);
  return (data as PolicyRow[] | null) ?? [];
}

/**
 * The agent-facing projection: `{slug, name, internal_summary}` for every ACTIVE, non-
 * superseded policy in the workspace. This is what the orchestrator + grader + director need —
 * the INTERNAL half only, never the published `customer_summary`. Used by the sonnet
 * orchestrator's `buildPoliciesSection`, the grader system prompt, the daily-analysis report,
 * and (Phase 2) the CS director's brief.
 */
export async function getInternalRules(
  admin: Admin,
  workspaceId: string,
): Promise<InternalPolicyRule[]> {
  const { data, error } = await admin
    .from("policies")
    .select("slug, name, internal_summary")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("slug");
  if (error) throw new Error(`policies.getInternalRules: ${error.message}`);
  return ((data as InternalPolicyRule[] | null) ?? []).map(r => ({
    slug: r.slug,
    name: r.name,
    internal_summary: r.internal_summary ?? "",
  }));
}

/** Input for {@link updatePolicyText}. Every field is optional — only the provided keys patch. */
export interface UpdatePolicyPatch {
  name?: string;
  customer_summary?: string;
  internal_summary?: string;
  rules?: unknown[];
  updated_by?: string | null;
}

export interface UpdatePolicyResult {
  id: string;
  version: number;
  /** True when the patch bumped `version` (content changed); false when it was a no-op patch. */
  versionBumped: boolean;
}

/**
 * Update the ACTIVE row for a workspace + slug in place. Bumps `version` iff the patched
 * content (`customer_summary` / `internal_summary` / `rules`) differs from the row's current
 * value — a name-only or updated_by-only patch does not bump. Always stamps `updated_at`.
 *
 * Returns the row's id + new `version` + `versionBumped`. Throws when the active row is
 * missing (nothing to patch) or when the update fails.
 */
export async function updatePolicyText(
  admin: Admin,
  workspaceId: string,
  slug: string,
  patch: UpdatePolicyPatch,
): Promise<UpdatePolicyResult> {
  const { data: current, error: readErr } = await admin
    .from("policies")
    .select("id, version, name, customer_summary, internal_summary, rules")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (readErr) throw new Error(`policies.updatePolicyText read(${slug}): ${readErr.message}`);
  if (!current) {
    throw new Error(`policies.updatePolicyText: no active policy for slug='${slug}' in workspace`);
  }

  const row: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.updated_by !== undefined) row.updated_by = patch.updated_by;
  if (typeof patch.name === "string" && patch.name.trim()) row.name = patch.name.trim();
  if (typeof patch.customer_summary === "string") row.customer_summary = patch.customer_summary;
  if (typeof patch.internal_summary === "string") row.internal_summary = patch.internal_summary;
  if (Array.isArray(patch.rules)) row.rules = patch.rules;

  const contentChanged =
    (row.customer_summary !== undefined && row.customer_summary !== current.customer_summary) ||
    (row.internal_summary !== undefined && row.internal_summary !== current.internal_summary) ||
    (row.rules !== undefined &&
      JSON.stringify(row.rules) !== JSON.stringify(current.rules));

  const nextVersion = contentChanged ? current.version + 1 : current.version;
  if (contentChanged) row.version = nextVersion;

  const { error: writeErr, data: written } = await admin
    .from("policies")
    .update(row)
    .eq("id", current.id)
    .select("id")
    .single();
  if (writeErr) throw new Error(`policies.updatePolicyText write(${slug}): ${writeErr.message}`);

  return {
    id: String(written.id),
    version: nextVersion,
    versionBumped: contentChanged,
  };
}

/**
 * Storefront-shaped projection for the public /policies/{slug} page. Returns
 * `customer_summary` + the display fields; hides `internal_summary` + `rules` (those never
 * belong on the customer page). Returns `null` when no active row matches.
 */
export interface CustomerFacingPolicy {
  slug: string;
  name: string;
  customer_summary: string;
  version: number;
  effective_at: string;
  updated_at: string;
}

export async function getPolicyCustomerFacing(
  admin: Admin,
  workspaceId: string,
  slug: string,
): Promise<CustomerFacingPolicy | null> {
  const { data, error } = await admin
    .from("policies")
    .select("slug, name, customer_summary, version, effective_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("slug", slug)
    .eq("is_active", true)
    .is("superseded_by", null)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`policies.getPolicyCustomerFacing(${slug}): ${error.message}`);
  return (data as CustomerFacingPolicy | null) ?? null;
}

/** Input for {@link insertDraftPolicy}. `slug` + `name` are required; the rest defaults sanely. */
export interface DraftPolicyInput {
  workspaceId: string;
  slug: string;
  name: string;
  customer_summary?: string;
  internal_summary?: string;
  rules?: unknown[];
}

/**
 * Insert a DRAFT policy row (`is_active=false`) — the entry point for the CS digest storyline
 * flow, which seeds a draft the founder edits into shape from Settings → Policies before
 * activating. Never activates on insert. Returns the new row id.
 */
export async function insertDraftPolicy(
  admin: Admin,
  input: DraftPolicyInput,
): Promise<{ id: string }> {
  const { data, error } = await admin
    .from("policies")
    .insert({
      workspace_id: input.workspaceId,
      slug: input.slug,
      name: input.name,
      customer_summary: input.customer_summary ?? "",
      internal_summary: input.internal_summary ?? "",
      rules: input.rules ?? [],
      is_active: false,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`policies.insertDraftPolicy(${input.slug}): ${error?.message ?? "no row"}`);
  }
  return { id: String(data.id) };
}
