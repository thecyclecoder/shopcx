/**
 * sol-direction-apply — Phase 2 of
 * docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta.md.
 *
 * When Sol's live Direction ([[ticket-directions]] `getLiveDirection` /
 * `loadLiveDirection`) resolves `chosen_path` to `'journey'` or `'playbook'`, the cheap-execution
 * turn ([[../inngest/unified-ticket-handler]]) APPLIES the matched mechanism deterministically:
 *
 *   - `chosen_path='journey'` + `plan.journey_slug` → `launchJourneyForTicket` (real token-authed
 *     CTA on a journey_deliveries row) with a `leadIn` generated to mirror the customer's incoming
 *     message (empathetic, plain text — same `generateJourneyLeadIn` the deployed orchestrator
 *     uses). NEVER a freeform "click below" reply that references a mechanism it did not launch.
 *
 *   - `chosen_path='playbook'` + `plan.playbook_slug` (fresh — `active_playbook_id IS NULL`) →
 *     `startPlaybook` + one `executePlaybookStep`. A follow-up turn on an already-running playbook
 *     is owned by the shortcircuit at [[../inngest/unified-ticket-handler]] (§ 3.98 sol-playbook-
 *     shortcircuit); this apply path only starts the FIRST step.
 *
 * Prompt-rule backstop — deterministic, no LLM. A `sonnet_prompts` rule that flags an intent as
 * self-service-only (e.g. "never cancel FOR the customer") reroutes a `chosen_path='playbook'`
 * Direction to the matching active journey so a direct-mutation playbook can never run on the
 * customer's behalf when the workspace has said self-service-only. If no matching journey exists,
 * the playbook path stays — the rule is a preference, not a hard block that leaves the customer
 * hanging.
 *
 * Read paths use the same tables the deployed orchestrator uses:
 *   - [[../tables/journey_definitions]] (is_active=true, workspace-scoped)
 *   - [[../tables/playbooks]] (is_active=true, workspace-scoped)
 *   - [[../tables/tickets]] `.active_playbook_id` — the fresh-vs-follow-up gate.
 *   - [[../tables/sonnet_prompts]] via the injected `loadRules` (matches the deployed
 *     `loadLiveRules` shape: enabled + approved).
 *
 * The module is READ-ONLY against the state tables — the mutations it performs go through the
 * injected effect functions (`launchJourney` / `startPlaybookFn` / `executePlaybookStepFn` /
 * `send` / `sysNote`) so unit tests exercise the branch decisions with pure stubs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TicketDirection } from "@/lib/ticket-directions";

type Admin = SupabaseClient;

export interface SolApplyPersonality {
  name?: string;
  tone?: string;
  sign_off?: string | null;
}

/** One rule row from `sonnet_prompts` (enabled + approved) — same shape [[cx-agent-sdk]] `CxPolicy`. */
export interface SolApplyRule {
  category: string;
  title: string;
  content: string;
}

export interface JourneyLaunchArgs {
  workspaceId: string;
  ticketId: string;
  customerId: string;
  journeyId: string;
  journeyName: string;
  triggerIntent: string;
  channel: string;
  leadIn: string;
  ctaText: string;
}

/**
 * Verdict returned by {@link applySolDirection}. `applied=true` means the mechanism ran and the
 * cheap-execution turn should NOT fall through to the Sonnet orchestrator; `applied=false` means
 * the caller falls through to Sonnet (the reason is stamped for diagnostics).
 */
export interface SolApplyResult {
  applied: boolean;
  kind: "journey" | "playbook" | "none";
  slug: string | null;
  reason:
    | "journey_launched"
    | "self_service_overrode_playbook"
    | "playbook_started"
    | "no_journey_slug"
    | "journey_not_found"
    | "journey_launch_failed"
    | "no_playbook_slug"
    | "playbook_not_found"
    | "playbook_already_active"
    | "not_applicable_path"
    | "direction_superseded";
  override?: "self_service" | null;
}

/**
 * Deterministic scan for a self-service-only rule that mentions the resolved intent. A rule is
 * self-service-only for `intent` when EITHER:
 *  - `category === 'self_service_only'` AND the rule content mentions the intent slug (or its
 *    space-separated surface form — a rule authored as "cancel subscription" matches
 *    `cancel_subscription`); OR
 *  - the content contains a "never <verb> for [the] customer" clause AND mentions the intent (the
 *    natural-language phrasing operators commonly use in `sonnet_prompts`).
 * Read-only pure function — safe to unit-test with a plain array.
 */
export function isSelfServiceOnlyIntent(rules: SolApplyRule[], intent: string): boolean {
  const target = (intent ?? "").toLowerCase();
  if (!target) return false;
  const targetSpaced = target.replace(/_/g, " ");
  return rules.some((r) => {
    const cat = (r.category ?? "").toLowerCase();
    const content = (r.content ?? "").toLowerCase();
    const mentions = content.includes(target) || content.includes(targetSpaced);
    if (!mentions) return false;
    if (cat === "self_service_only") return true;
    if (/never\s+\w+\s+for\s+(the\s+)?customer/.test(content)) return true;
    return false;
  });
}

export interface SolApplyDeps {
  admin: Admin;
  workspaceId: string;
  ticketId: string;
  customerId: string;
  channel: string;
  message: string;
  personality: SolApplyPersonality | null;
  sandbox: boolean;
  send: (msg: string, sandbox: boolean) => Promise<void>;
  sysNote: (m: string) => Promise<void>;
  generateLeadIn: (
    msg: string,
    journeyName: string,
    ch: string,
    p: SolApplyPersonality | null,
  ) => Promise<{ leadIn: string; ctaText: string }>;
  launchJourney: (args: JourneyLaunchArgs) => Promise<boolean>;
  startPlaybookFn: (
    admin: Admin,
    ticketId: string,
    playbookId: string,
    opts?: { seed_context?: Record<string, unknown> },
  ) => Promise<void>;
  executePlaybookStepFn: (
    workspaceId: string,
    ticketId: string,
    msg: string,
    personality: SolApplyPersonality | null,
  ) => Promise<{ action?: string; response?: string | null; systemNote?: string | null }>;
  loadRules?: (admin: Admin, workspaceId: string) => Promise<SolApplyRule[]>;
}

/**
 * Apply the matched mechanism named on the Direction. Returns the verdict the caller stamps on
 * `ticket_resolution_events.reasoning` (e.g. `'sol:direction-apply:journey:cancel_subscription'`)
 * and uses to decide whether to skip the Sonnet orchestrator.
 *
 * Guards (per learning #6 — the confirming predicate at the action point, not a coarser proxy):
 *  - `direction.superseded_at IS NULL` re-asserted here even though the caller filters — a racing
 *    supersede between load and apply must not authorize a stale mechanism.
 *  - `chosen_path` narrowed to `journey`/`playbook` explicitly; `stateless`/`needs_info` fall
 *    through to Sonnet (they are NOT this path's job).
 *  - Journey/playbook lookups re-scope by workspace_id + is_active=true so a slug that got
 *    deactivated after the Direction was written won't fire.
 *  - Playbook path re-checks `active_playbook_id IS NULL` — a concurrent follow-up turn has
 *    already claimed the ticket → return `playbook_already_active` and let the caller's existing
 *    shortcircuit handle it.
 *
 * Self-service backstop: if the Direction is `chosen_path='playbook'` AND `isSelfServiceOnlyIntent`
 * returns true AND a matching active journey exists for the same intent, we OVERRIDE to journey —
 * the deterministic version of the natural-language "never cancel FOR the customer" rule so the
 * mutation never happens on the customer's behalf.
 */
export async function applySolDirection(
  direction: TicketDirection,
  deps: SolApplyDeps,
): Promise<SolApplyResult> {
  if (direction.superseded_at) {
    return { applied: false, kind: "none", slug: null, reason: "direction_superseded" };
  }
  const chosen = direction.chosen_path;
  if (chosen !== "journey" && chosen !== "playbook") {
    return { applied: false, kind: "none", slug: null, reason: "not_applicable_path" };
  }

  let effectiveChosen: "journey" | "playbook" = chosen;
  let effectivePlan = direction.plan;
  let override: "self_service" | null = null;

  if (chosen === "playbook") {
    const rules = deps.loadRules ? await deps.loadRules(deps.admin, deps.workspaceId) : [];
    if (isSelfServiceOnlyIntent(rules, direction.intent)) {
      const norm = (s: string | null | undefined) => (s ?? "").toLowerCase();
      const target = norm(direction.intent);
      const { data: activeJourneys } = await deps.admin
        .from("journey_definitions")
        .select("id, slug, name, trigger_intent")
        .eq("workspace_id", deps.workspaceId)
        .eq("is_active", true);
      const rows = (activeJourneys ?? []) as Array<{
        id: string;
        slug: string;
        name: string;
        trigger_intent: string | null;
      }>;
      const match = rows.find((j) => norm(j.trigger_intent) === target) ?? null;
      if (match) {
        effectiveChosen = "journey";
        effectivePlan = { ...direction.plan, journey_slug: match.slug };
        override = "self_service";
        await deps.sysNote(
          `[System] Sol Direction override: self-service-only rule matched intent='${direction.intent}' — routing to journey '${match.slug}' instead of playbook '${direction.plan.playbook_slug ?? "?"}'.`,
        );
      }
    }
  }

  if (effectiveChosen === "journey") {
    const slug = effectivePlan.journey_slug;
    if (typeof slug !== "string" || slug.trim().length === 0) {
      return { applied: false, kind: "none", slug: null, reason: "no_journey_slug", override };
    }
    const { data: journey } = await deps.admin
      .from("journey_definitions")
      .select("id, name, slug, trigger_intent")
      .eq("workspace_id", deps.workspaceId)
      .eq("slug", slug)
      .eq("is_active", true)
      .maybeSingle();
    if (!journey) {
      return { applied: false, kind: "none", slug, reason: "journey_not_found", override };
    }
    const j = journey as { id: string; name: string; slug: string; trigger_intent: string | null };
    const { leadIn, ctaText } = await deps.generateLeadIn(
      deps.message,
      j.name,
      deps.channel,
      deps.personality,
    );
    const launched = await deps.launchJourney({
      workspaceId: deps.workspaceId,
      ticketId: deps.ticketId,
      customerId: deps.customerId,
      journeyId: j.id,
      journeyName: j.name,
      triggerIntent: j.trigger_intent ?? "",
      channel: deps.channel,
      leadIn,
      ctaText: ctaText || j.name,
    });
    if (!launched) {
      return { applied: false, kind: "journey", slug: j.slug, reason: "journey_launch_failed", override };
    }
    return {
      applied: true,
      kind: "journey",
      slug: j.slug,
      reason: override === "self_service" ? "self_service_overrode_playbook" : "journey_launched",
      override,
    };
  }

  const slug = effectivePlan.playbook_slug;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    return { applied: false, kind: "none", slug: null, reason: "no_playbook_slug", override };
  }
  const { data: playbook } = await deps.admin
    .from("playbooks")
    .select("id, name, slug")
    .eq("workspace_id", deps.workspaceId)
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (!playbook) {
    return { applied: false, kind: "none", slug, reason: "playbook_not_found", override };
  }
  const pb = playbook as { id: string; name: string; slug: string };

  const { data: ticketRow } = await deps.admin
    .from("tickets")
    .select("active_playbook_id")
    .eq("workspace_id", deps.workspaceId)
    .eq("id", deps.ticketId)
    .maybeSingle();
  const activePbId = (ticketRow as { active_playbook_id: string | null } | null)?.active_playbook_id ?? null;
  if (activePbId) {
    return { applied: false, kind: "none", slug: pb.slug, reason: "playbook_already_active", override };
  }

  const seedCtx =
    effectivePlan.playbook_seed_context && typeof effectivePlan.playbook_seed_context === "object"
      ? (effectivePlan.playbook_seed_context as Record<string, unknown>)
      : {};

  await deps.startPlaybookFn(deps.admin, deps.ticketId, pb.id, { seed_context: seedCtx });
  const result = await deps.executePlaybookStepFn(
    deps.workspaceId,
    deps.ticketId,
    deps.message,
    deps.personality,
  );
  if (result.systemNote) await deps.sysNote(result.systemNote);
  if (result.response) await deps.send(result.response, deps.sandbox);
  return { applied: true, kind: "playbook", slug: pb.slug, reason: "playbook_started", override };
}
