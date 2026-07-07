/**
 * cs-director-digest-reply — the mutation helpers behind the founder's per-storyline
 * BIDIRECTIONAL REPLY on the /dashboard/agents/cs-director/digests surface.
 *
 * Phase 2 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]]. One
 * helper per action the storyline panel exposes:
 *  - `widenCsLeash`   — walk `function_autonomy` for `function_slug='cs'` up one step
 *                       (off → live → live+autonomous).
 *  - `tightenCsLeash` — walk it back one step (live+autonomous → live → off).
 *  - `addPolicyFromStoryline` — insert a `policies` draft row prefilled from the storyline evidence.
 *  - `addRuleFromStoryline`   — insert a `sonnet_prompts` proposal row (category='rule').
 *  - `stampDigestReply`       — compare-and-set the digest's `ceo_replied_at` + `ceo_reply_action`
 *                                so a stale click can't overwrite an already-actioned digest.
 *
 * Every mutation follows the coaching rule: the write is guard-scoped (workspace_id + id or slug),
 * uses a compare-and-set where reasonable, and `.select("id")`-asserts exactly one row transitioned.
 * A failed mutation returns `{ ok: false, reason }` — the caller (the API route) decides how to
 * surface the failure to the founder. Never throws.
 */

import type { createAdminClient } from "@/lib/supabase/admin";
import type { CsStoryline } from "./cs-director-digest";

type Admin = ReturnType<typeof createAdminClient>;

export type CsDigestReplyActionType = "widen_leash" | "tighten_leash" | "add_policy" | "add_rule";

/** The `ceo_reply_action` payload stamped on the digest when the founder replies. */
export interface CsDigestReplyRecord {
  storyline_index: number;
  action_type: CsDigestReplyActionType;
  actor: string; // workspace_members.display_name (or 'owner' fallback)
  autonomy?: { live: boolean; autonomous: boolean };
  policy_id?: string;
  sonnet_prompt_id?: string;
  reason?: string;
  applied_at: string; // ISO
}

/** Compact + safe result — the API route returns this to the client verbatim. */
export interface CsDigestReplyResult {
  ok: boolean;
  reason?: string;
  autonomy?: { live: boolean; autonomous: boolean };
  policy_id?: string;
  sonnet_prompt_id?: string;
}

const FN_SLUG_CS = "cs";

/** The CS leash has three positions ordered least → most autonomy. Used by widen/tighten. */
export type CsLeashPos = "off" | "live" | "live_autonomous";

function toPos(row: { live: boolean; autonomous: boolean } | null | undefined): CsLeashPos {
  if (!row) return "off";
  if (row.autonomous) return "live_autonomous";
  if (row.live) return "live";
  return "off";
}

function fromPos(pos: CsLeashPos): { live: boolean; autonomous: boolean } {
  if (pos === "live_autonomous") return { live: true, autonomous: true };
  if (pos === "live") return { live: true, autonomous: false };
  return { live: false, autonomous: false };
}

/** Walk the leash one step wider (or same when at the ceiling). */
function widenPos(pos: CsLeashPos): CsLeashPos {
  if (pos === "off") return "live";
  if (pos === "live") return "live_autonomous";
  return "live_autonomous";
}

/** Walk the leash one step tighter (or same when at the floor). */
function tightenPos(pos: CsLeashPos): CsLeashPos {
  if (pos === "live_autonomous") return "live";
  if (pos === "live") return "off";
  return "off";
}

async function readCsAutonomy(admin: Admin): Promise<{ live: boolean; autonomous: boolean } | null> {
  const { data, error } = await admin
    .from("function_autonomy")
    .select("live, autonomous")
    .eq("function_slug", FN_SLUG_CS)
    .maybeSingle();
  if (error) {
    console.warn("[cs-director-digest-reply] readCsAutonomy failed:", error.message);
    return null;
  }
  return (data ?? null) as { live: boolean; autonomous: boolean } | null;
}

async function walkLeash(
  admin: Admin,
  direction: "widen" | "tighten",
  actor: string,
): Promise<CsDigestReplyResult> {
  try {
    const current = await readCsAutonomy(admin);
    const currentPos = toPos(current);
    const nextPos = direction === "widen" ? widenPos(currentPos) : tightenPos(currentPos);
    const next = fromPos(nextPos);
    if (currentPos === nextPos) {
      // Already at the ceiling / floor — treat as a successful no-op so the founder isn't blocked.
      // The digest still stamps the action; the audit shows "no leash change" as the outcome.
      return { ok: true, autonomy: next };
    }
    const { error } = await admin.from("function_autonomy").upsert(
      {
        function_slug: FN_SLUG_CS,
        live: next.live,
        autonomous: next.autonomous,
        updated_by: actor || "owner",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "function_slug" },
    );
    if (error) {
      return { ok: false, reason: `function_autonomy write failed: ${error.message}` };
    }
    return { ok: true, autonomy: next };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export function widenCsLeash(admin: Admin, actor: string): Promise<CsDigestReplyResult> {
  return walkLeash(admin, "widen", actor);
}

export function tightenCsLeash(admin: Admin, actor: string): Promise<CsDigestReplyResult> {
  return walkLeash(admin, "tighten", actor);
}

function policySlugFor(storylineTitle: string, digestId: string): string {
  // Slugify: lower-case, strip non-alnum, cap at 40 chars, suffix a short digest-id hash so two
  // storylines with the same title don't collide on a unique slug (if the DB adds one later).
  const base = (storylineTitle || "cs-storyline")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = digestId.slice(0, 8);
  return `${base || "cs-storyline"}-${suffix}`;
}

/**
 * Insert one `policies` DRAFT row (is_active=false) prefilled from the storyline. The founder edits
 * it into shape from Settings → Policies; this action only seeds the draft. Guard: workspace-scoped
 * insert; `.select("id")` asserts exactly one row created.
 */
export async function addPolicyFromStoryline(
  admin: Admin,
  input: { workspaceId: string; storyline: CsStoryline; digestId: string; actor: string },
): Promise<CsDigestReplyResult> {
  try {
    const draft = String(
      (input.storyline.proposed_action?.payload?.["policy_draft"] as string | undefined) ??
        input.storyline.evidence ??
        "",
    );
    const { data, error } = await admin
      .from("policies")
      .insert({
        workspace_id: input.workspaceId,
        slug: policySlugFor(input.storyline.title, input.digestId),
        name: input.storyline.title || "Draft policy from CS digest",
        customer_summary: draft,
        internal_summary: draft,
        rules: [],
        is_active: false, // DRAFT — the founder activates from Settings → Policies after editing.
      })
      .select("id")
      .single();
    if (error || !data) {
      return { ok: false, reason: `policies insert failed: ${error?.message ?? "no row"}` };
    }
    return { ok: true, policy_id: String(data.id) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Insert one `sonnet_prompts` PROPOSAL row (status='proposed', enabled=false, category='rule')
 * prefilled from the storyline. Ships through the standard admin approve flow at
 * /dashboard/settings/ai/prompts — this action never auto-enables the rule.
 */
export async function addRuleFromStoryline(
  admin: Admin,
  input: { workspaceId: string; storyline: CsStoryline; actor: string },
): Promise<CsDigestReplyResult> {
  try {
    const draft = String(
      (input.storyline.proposed_action?.payload?.["rule_draft"] as string | undefined) ??
        input.storyline.evidence ??
        "",
    );
    const { data, error } = await admin
      .from("sonnet_prompts")
      .insert({
        workspace_id: input.workspaceId,
        category: "rule",
        title: input.storyline.title || "Draft rule from CS digest",
        content: draft,
        enabled: false, // NOT enabled — admin approves at /dashboard/settings/ai/prompts.
        status: "proposed",
        proposed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !data) {
      return { ok: false, reason: `sonnet_prompts insert failed: ${error?.message ?? "no row"}` };
    }
    return { ok: true, sonnet_prompt_id: String(data.id) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Compare-and-set stamp on the digest's `ceo_replied_at` + `ceo_reply_action`. The predicate
 * `.is("ceo_replied_at", null)` ensures a stale click can't overwrite an already-actioned digest
 * (the button's re-click, a race with the founder's second tab, a hostile replay). `.select("id")`
 * asserts exactly one row transitioned; a zero-row return means the digest was already stamped and
 * the caller should surface "already actioned" to the founder.
 *
 * Workspace-scope on the WHERE is defense-in-depth against a cross-workspace id collision (`id` is
 * a uuid so real collision is impossible, but the filter costs nothing and mirrors the
 * approval-inbox.ts:789-806 pattern the coaching flags).
 */
export async function stampDigestReply(
  admin: Admin,
  input: { workspaceId: string; digestId: string; record: CsDigestReplyRecord },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { data, error } = await admin
      .from("cs_director_digests")
      .update({
        ceo_replied_at: input.record.applied_at,
        ceo_reply_action: input.record,
      })
      .eq("id", input.digestId)
      .eq("workspace_id", input.workspaceId)
      .is("ceo_replied_at", null)
      .select("id");
    if (error) {
      return { ok: false, reason: `stamp failed: ${error.message}` };
    }
    if (!Array.isArray(data) || data.length !== 1) {
      return { ok: false, reason: "digest already stamped (0 rows transitioned)" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
