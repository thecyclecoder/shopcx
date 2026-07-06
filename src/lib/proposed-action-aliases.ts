/**
 * proposed_action_aliases — the review queue for Sonnet-emitted action types
 * that missed every handler AND the alias catalog.
 *
 * `recordUnknownActionType` is called by the executor on every silent-miss
 * hit. It:
 *   1. Upserts a (workspace_id, source_type) row (bumps occurrences, updates
 *      last_seen, refreshes the most-recent ticket_id).
 *   2. If occurrences >= 3 and no suggested_target yet, calls Haiku with the
 *      canonical directActionHandlers key list to propose a target — cheap
 *      enough to run on the hot path without gating a separate cron.
 *
 * See docs/brain/specs/orchestrator-handler-alias-catalog-for-no-handler-misses.md
 * (Phase 2) and docs/brain/tables/proposed_action_aliases.md.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SUGGEST_AT_OCCURRENCES = 3;

export interface RecordArgs {
  admin: Admin;
  workspaceId: string;
  ticketId: string;
  sourceType: string;
  // The canonical handler keys registered in `directActionHandlers`. Passed
  // in (not imported) to keep this module free of the action-executor's
  // heavy transitive imports so it stays trivially testable.
  handlerKeys: string[];
}

/**
 * Fire-and-forget on the hot path. Any error here MUST NOT interfere with
 * the customer-facing response — the executor is already about to surface
 * an "Unknown action type" failure; the recording is telemetry only.
 */
export async function recordUnknownActionType(args: RecordArgs): Promise<void> {
  const { admin, workspaceId, ticketId, sourceType, handlerKeys } = args;
  try {
    // Do the compare-and-set upsert: if the row exists bump the counter +
    // last_seen + most-recent ticket, otherwise insert a fresh row.
    //
    // Guard predicate: the .select("id, occurrences, suggested_target,
    // status") back means we only decide whether to invoke Sonnet on the
    // returned counter (not a re-read that could race a concurrent hit).
    const now = new Date().toISOString();
    const { data: existing } = await admin
      .from("proposed_action_aliases")
      .select("id, occurrences, suggested_target, status")
      .eq("workspace_id", workspaceId)
      .eq("source_type", sourceType)
      .maybeSingle();

    let row: { id: string; occurrences: number; suggested_target: string | null; status: string } | null =
      existing as typeof existing & { id: string; occurrences: number; suggested_target: string | null; status: string } | null;

    if (!row) {
      const { data: inserted, error } = await admin
        .from("proposed_action_aliases")
        .insert({
          workspace_id: workspaceId,
          source_type: sourceType,
          ticket_id: ticketId,
          occurrences: 1,
          first_seen: now,
          last_seen: now,
        })
        .select("id, occurrences, suggested_target, status")
        .single();
      if (error) return;
      row = inserted;
    } else {
      // Compare-and-set on the read row's id + workspace so a concurrent hit
      // in a different workspace cannot be touched by this update.
      const { data: updated } = await admin
        .from("proposed_action_aliases")
        .update({
          occurrences: row.occurrences + 1,
          last_seen: now,
          ticket_id: ticketId,
          updated_at: now,
        })
        .eq("id", row.id)
        .eq("workspace_id", workspaceId)
        .select("id, occurrences, suggested_target, status")
        .single();
      if (updated) row = updated;
    }

    if (!row) return;

    // Only propose a target when:
    //   - the row is still pending admin review (a declined/approved row must
    //     not be re-prompted or overwritten — enforce the invariant here so a
    //     stale read cannot re-open a declined queue item),
    //   - occurrences reached the SUGGEST threshold,
    //   - no suggestion has been made yet (single-shot per row).
    if (row.status !== "pending") return;
    if (row.occurrences < SUGGEST_AT_OCCURRENCES) return;
    if (row.suggested_target) return;

    const suggestion = await suggestTargetHandler(sourceType, handlerKeys);
    if (!suggestion) return;

    // Compare-and-set: only write the suggestion if the row is STILL pending
    // AND still has a null suggested_target. This is the guard-before-mutation
    // discipline — two concurrent hits both crossing the threshold cannot
    // race a suggestion in twice.
    await admin
      .from("proposed_action_aliases")
      .update({
        suggested_target: suggestion.target,
        suggested_at: new Date().toISOString(),
        suggested_model: HAIKU_MODEL,
        suggested_reasoning: suggestion.reasoning,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
      .eq("workspace_id", workspaceId)
      .eq("status", "pending")
      .is("suggested_target", null);
  } catch {
    // Swallow — telemetry only.
  }
}

interface Suggestion {
  target: string;
  reasoning: string;
}

/**
 * Ask Haiku to pick the best-matching canonical handler key for a
 * Sonnet-emitted source_type. Returns null on any error / no confident
 * match (the queue row just keeps counting; an admin can still author a
 * manual alias in the meantime).
 *
 * Exposed for testing via the direct handler list; the network side of the
 * call is guarded by a missing API key check so a spec-test / CI run with
 * no key configured resolves cleanly to null.
 */
export async function suggestTargetHandler(
  sourceType: string,
  handlerKeys: string[],
): Promise<Suggestion | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (handlerKeys.length === 0) return null;

  const prompt = buildSuggestPrompt(sourceType, handlerKeys);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data.content?.[0]?.text || "") as string;
    return parseSuggestion(text, handlerKeys);
  } catch {
    return null;
  }
}

export function buildSuggestPrompt(sourceType: string, handlerKeys: string[]): string {
  return [
    "The AI customer-support orchestrator emitted an action_type that does not match any registered handler.",
    "",
    `emitted action_type: "${sourceType}"`,
    "",
    "Registered handler keys (pick EXACTLY ONE from this list, or return no_match):",
    handlerKeys.map((k) => `  - ${k}`).join("\n"),
    "",
    "Return ONLY a JSON object:",
    '  { "target": "<one of the keys above>" | "no_match", "reasoning": "one short sentence" }',
    "",
    'If none of the keys is a clear semantic match, return "target": "no_match".',
  ].join("\n");
}

/**
 * Parse the Haiku response. Rejects any target that is not in the passed-in
 * handlerKeys list — an out-of-set match would silently teach the executor
 * to route to a non-existent handler, which is exactly the bug this queue
 * exists to catch. Also rejects the sentinel "no_match".
 */
export function parseSuggestion(text: string, handlerKeys: string[]): Suggestion | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const target = String(parsed?.target || "").trim();
    const reasoning = String(parsed?.reasoning || "").trim();
    if (!target || target === "no_match") return null;
    if (!handlerKeys.includes(target)) return null;
    return { target, reasoning };
  } catch {
    return null;
  }
}
