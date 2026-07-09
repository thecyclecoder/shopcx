# libraries/ticket-directions

Server SDK for the durable **Direction artifact** Sol writes ONCE per ticket on the first-touch box session ([[../tables/ticket_directions]] · [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]]). Backs the one-live-row invariant enforced by the DB-level partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL`. All writes go through a service-role client passed in by the caller (`createAdminClient()` in the worker — per CLAUDE.md's "All writes go through createAdminClient()").

**File:** `src/lib/ticket-directions.ts`

## Types

- `TicketDirectionPath = "playbook" | "journey" | "workflow" | "stateless" | "needs_info"` — the five treatment paths Sol can commit the ticket to on first touch. `playbook` drives an existing playbook; `journey` launches a matched [[../tables/journey_definitions|journey]] (cancellation is the flagship — `cancel-subscription`, the save flow); `workflow` runs a matched [[../tables/workflows|workflow]] (guided smart flow, identified by `trigger_tag`); `stateless` is a single stateless reply; `needs_info` asks the customer for a specific missing piece before any action. Sol picks from the **MECHANISMS CATALOG** block [[../../scripts/builder-worker]] `loadMechanismsCatalog` injects into her brief (all active journeys/workflows/playbooks for the workspace+channel). **At first touch the box delivers the mechanism itself** ([[../../scripts/builder-worker]] `runTicketHandleJob`): `journey` → [[tickets-mutate]] `launchJourney(leadIn=first_reply)` (one message: lead-in + CTA), `workflow` → `runWorkflow`, then the live Direction is **superseded** so the on-reply [[sol-direction-apply]] path can't re-launch it. `playbook` is armed reply-gated ([[sol-mechanism-arm]]).
- `TicketDirection` — the full row: `{ id, workspace_id, ticket_id, intent, context_summary, chosen_path, plan, guardrails, authored_by, authored_at, superseded_at, resession_count }`. `guardrails` is `Record<string, unknown>` (Sol picks the bounded proxies; hitting a rail = escalate — see [[../../CLAUDE]] § North star). `plan` is the typed `TicketDirectionPlan` (see plan-shape below).
- `TicketDirectionPlanError` — typed exception thrown by `writeDirection` when the plan violates the path-specific contract. Carries `code: 'playbook_slug_missing' | 'playbook_slug_unknown' | 'playbook_slug_not_string' | 'journey_slug_missing' | 'journey_slug_unknown' | 'journey_slug_not_string' | 'workflow_tag_missing' | 'workflow_tag_unknown' | 'workflow_tag_not_string'` + `slug?` so callers can render user-legible diagnostics without string-matching on `message`.

## Plan-shape

`plan` is `TicketDirectionPlan` — a path-specific object the writer validates BEFORE the row lands so downstream cheap-execution can dispatch without re-doing full-context reasoning:

| `chosen_path` | Required `plan` keys | Optional `plan` keys | Writer check |
|---|---|---|---|
| `playbook` | `playbook_slug` (string, must exist in `public.playbooks.slug` for this workspace) | `playbook_seed_context` (record — order/subscription/customer ids to merge into `tickets.playbook_context` on step 0) | short lookup `SELECT id FROM playbooks WHERE workspace_id=? AND slug=?` — a null result throws `TicketDirectionPlanError(code='playbook_slug_unknown')` with the slug echoed |
| `journey` | `journey_slug` (string, must exist in `public.journey_definitions.slug` with `is_active=true` for this workspace) | `cta_text` (button label override) | short lookup `SELECT id FROM journey_definitions WHERE workspace_id=? AND slug=? AND is_active=true` — a null result throws `TicketDirectionPlanError(code='journey_slug_unknown')`. At first touch the box calls `launchJourney(leadIn=first_reply)` — one message (lead-in + CTA), never a freeform "click below" |
| `workflow` | `workflow_tag` (string, must match an `enabled` row's `trigger_tag` in `public.workflows` — workflows have no slug) | — | short lookup `SELECT id FROM workflows WHERE workspace_id=? AND trigger_tag=? AND enabled=true` — a null result throws `TicketDirectionPlanError(code='workflow_tag_unknown')`. At first touch the box calls `runWorkflow(workflow_tag)`; the workflow drives its own messages + status |
| `stateless` | — (Sol conventionally sets `action:"send_stateless_reply"`) | — | shape-only, no cross-table lookup |
| `needs_info` | — (Sol conventionally sets `needs:[…]` with the concrete list of missing pieces) | — | shape-only, no cross-table lookup |

Extra keys are preserved (path-specific ad-hoc knobs Sol may add). The `playbook` gate is Phase 1 of [[../specs/sol-session-chosen-playbook-selection-retire-brittle-triggers]] — the choice of which playbook to run moves inside Sol's first-touch box session, retiring the signal-based matcher for the Sol cohort in Phase 2. Cross-link: [[../playbooks/README]] lists the currently active playbook slugs.

## Exports

### `writeDirection` — function

```ts
async function writeDirection(
  admin: Admin,
  input: {
    workspace_id: string;
    ticket_id: string;
    intent: string;
    context_summary: string;
    chosen_path: TicketDirectionPath;
    plan?: TicketDirectionPlan;
    guardrails?: Record<string, unknown>;
    authored_by?: string;
  },
): Promise<TicketDirection>
```

Inserts one LIVE Direction (`superseded_at IS NULL`) for a ticket. The DB-level partial UNIQUE guarantees exactly one live row per ticket — a concurrent second `writeDirection` on the same ticket errors here with `23505 unique_violation` (Postgres). Callers re-authoring a Direction MUST call `superseDirection` first. Default `authored_by` = `'sol_box_session'` (the spec's Phase 3 verification bullet asserts this value on Sol-written rows).

Validates the `plan` against the `chosen_path` contract BEFORE the row is inserted (see [Plan-shape](#plan-shape)). For `chosen_path='playbook'` the writer runs a short `SELECT id FROM playbooks WHERE workspace_id=? AND slug=?` — a missing or unknown slug throws `TicketDirectionPlanError` with the slug echoed on the exception, so the caller (runTicketHandleJob → the worker) surfaces the diagnostic verbatim in the box-session log instead of the row landing with a slug the executor can't dispatch.

**Called by:** `runTicketHandleJob` in [[../../scripts/builder-worker]] — after parsing Sol's final JSON and re-asserting the required-field invariant (learning #1 — the write is guarded on `intent`/`context_summary`/`chosen_path ∈ {playbook, stateless, needs_info}` before firing).

### `superseDirection` — function

```ts
async function superseDirection(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketDirection | null>
```

Compare-and-set on the live row: stamps `superseded_at = now()` on the single row where `ticket_id = ? AND superseded_at IS NULL` (and optionally `workspace_id = ?` to defend a cross-workspace ticket-id collision). Returns the superseded row, OR `null` when there was no live row (or another caller won the race — the compare-and-set on `superseded_at IS NULL` guarantees a stale stamp can't overwrite a fresh one).

**Called by:** future inflection handling (Phase 3 lands the dispatcher; a later spec wires the rare-inflection path — customer pivot / guardrail rail-hit — that calls `superseDirection` + a fresh `writeDirection`).

### `getLiveDirection` — function

```ts
async function getLiveDirection(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketDirection | null>
```

Reads the live Direction for a ticket (`superseded_at IS NULL`), or `null` when Sol hasn't authored one yet. Uses `maybeSingle()` under the partial-UNIQUE invariant, so a corrupted state (two live rows) would surface as a query error rather than silently returning one. Optional `workspace_id` scope guards cross-workspace collisions.

**Called by:** future cheap-execution dispatchers (Phase 3 lands the unified-ticket-handler branch that calls `getLiveDirection` and drives off `chosen_path` + `plan` + `guardrails` instead of re-running the full-context orchestrator prompt).

### `closeTicketOnResolvingReply` — function

```ts
async function closeTicketOnResolvingReply(
  admin: Admin,
  opts: { workspace_id: string; ticket_id: string },
): Promise<void>
```

Message_sent → close. Phase 1 of [[../specs/sol-closes-ticket-on-resolving-reply-so-cora-grades-it]]. Sol's first-touch box session (`runTicketHandleJob` in [[../../scripts/builder-worker]]) sends a resolving reply through [[./ticket-delivery]] `deliverTicketMessage` but historically never closed the ticket — so it stayed `open` and [[./ticket-analyzer]]'s closed-tickets-only sweep never enqueued Cora to grade it. This helper is the single, shared close write mirroring [[../inngest/unified-ticket-handler]]'s local `setStatus` semantics (documented rule: **"message_sent → close the ticket; next inbound reopens"**). NOT a parallel path — same six-field update:

- `status = 'closed'`
- `closed_at = now()`
- `updated_at = now()`
- `escalated_at = null` · `escalated_to = null` · `escalation_reason = null` (clears the escalation triple so a previously-escalated-then-resolved ticket doesn't linger in the Escalated view)

**Guarded by workspace_id.** Compare-and-set on `.eq('workspace_id', …).eq('id', …)` (learning #6 — the confirming predicate at the action point, not a coarser proxy) — a cross-workspace ticket id can never authorize the close. Idempotent for the message_sent case: a racing close from a follow-up turn is a no-op because the row is already closed.

**Called by:** `runTicketHandleJob` in [[../../scripts/builder-worker]] — gated on `classifySolBoxTurnAction(...) === 'message_sent'`. **Founder rule (2026-07-09): EVERY shipped Sol message closes the ticket** (see the classifier below). A customer reply reopens it, and the mechanism the box armed at first touch ([[./sol-mechanism-arm]] → `active_playbook_id` → the `sol-playbook-shortcircuit`) drives from there. Only a FAILED send leaves it open.

### `classifySolBoxTurnAction` — function

```ts
type SolBoxTurnAction = "message_sent" | "status_managed" | "keep_open" | "escalated";

function classifySolBoxTurnAction(input: {
  chosen_path: string;
  send_ok: boolean;
}): SolBoxTurnAction
```

Post-execute action taxonomy for a Sol box-session turn. **Founder rule (2026-07-09): every shipped Sol message closes the ticket** — the classifier now keys on `send_ok` alone (`send_ok → message_sent`, else `keep_open`), regardless of `chosen_path`. The prior taxonomy returned `status_managed` for `playbook`/`journey` (leave open, "the mechanism owns status"), but the box never armed the mechanism — so those tickets sat **dormant-and-open** when nothing later closed them (marty `125741eb`). Now the box arms the playbook reply-gated ([[./sol-mechanism-arm]]) AND closes; a customer reply reopens and the armed playbook drives.

| `chosen_path` | `send_ok` | Action | Ticket state |
|---|---|---|---|
| any (stateless / needs_info / playbook / journey) | `true` | `message_sent` | **CLOSE** — the message shipped; a customer reply reopens it |
| any | `false` | `keep_open` | stays open (send failed; a human retries via Improve) |

For `playbook`, Sol's opening reply IS the playbook's `apply_policy`/stand-firm step; the box arms the playbook at the step AFTER that (the `offer_exception`/action step) so it resumes there on the reply — no repeat of the opening, no double-send at arm time (arm is a silent state-set). Journeys are CTA-driven (not reply-driven) so their "arm" is a send-path change (Sol's opening carries the CTA), not handled here.

The `escalated` return is reserved for the caller's `needs_human` branch — Sol's box session returns `status='needs_human'` BEFORE any Direction is written, so no `chosen_path` string is available at classification time. The taxonomy value is kept on the enum so tests and future call sites share one vocabulary.

Pure predicate — no DB access, safe to unit-test in isolation ([[../../src/lib/ticket-directions.test]]).

**Called by:** `runTicketHandleJob` in [[../../scripts/builder-worker]] — the classifier is the confirming predicate at the close-decision action point.

### `incrementResessionCount` — function

```ts
async function incrementResessionCount(
  admin: Admin,
  input: { workspace_id: string; direction_id: string; from_count: number },
): Promise<number | null>
```

Bumps `resession_count` on the LIVE Direction by 1. Phase 2 of [[../specs/sol-runaway-re-session-cap-guardrail]] — [[./inflection-detector]] `reSessionSol` calls this BEFORE the supersede so the incremented count is durably captured on the row that is about to be superseded. Compare-and-set on `(id = direction_id AND workspace_id = … AND superseded_at IS NULL)` + `.select('id')` — a racing supersede returns zero rows and this function returns `null` so the caller can bail without double-counting.

**Called by:** [[./inflection-detector]] `reSessionSol` (below-cap branch). Returns the NEW count (`from_count + 1`) on success, or `null` when the compare-and-set found zero live rows (already superseded).

## Invariants

- **One live row per ticket.** Enforced by the DB partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL` — the SDK does NOT re-check in application code (a select-then-insert race defeats that; the DB is the authority). A `writeDirection` failure with `23505` = a live row already exists.
- **Directions are authored, never mutated.** Only `superseDirection` ever changes a row's `superseded_at`; no export mutates `intent` / `plan` / `guardrails` in place.
- **Compare-and-set on supersede.** `superseDirection`'s write is `.eq("ticket_id", …).is("superseded_at", null)` — a racing supersede returns zero rows and the caller sees `null` (learning #1 — re-assert the read-time precondition in the write itself).
- **Service-role only.** Every export takes `admin: SupabaseClient` — RLS is on with no policies, so a non-service-role read/write is rejected at the DB. Never call from client code.
- **Only `message_sent` closes.** The `classifySolBoxTurnAction` taxonomy is the single, shared close-decision predicate for the Sol box lane — mirroring [[../inngest/unified-ticket-handler]]'s `PostExecuteAction`. `keep_open` (needs_info clarifying question, failed send), `status_managed` (playbook / journey mechanism owns state), and `escalated` (needs_human punt) all leave the ticket `open`. This is what makes Cora's grade fire: [[./ticket-analyzer]]'s closed-tickets-only sweep enqueues a Cora grade for the newly-closed ticket via `enqueueTicketAnalyzeJob`, and the reopen-on-inbound path in the per-channel webhooks (email / sms / widget) flips a closed ticket back to `open` when the customer replies. See [[../specs/sol-closes-ticket-on-resolving-reply-so-cora-grades-it]].

## Sol operating rules (folded from [[../specs/sol-reviews-policies-and-never-bais-an-out-of-policy-outcome-full-research-session]])

Three durable rules the Sol first-touch box session lives under — all three are enforced at the Direction layer, not left to the prompt alone. Derived-from-ticket 87ce35a1 (Sol offered a customer two coffee-subscription returns the return policy would never honor).

1. **Policy review is mandatory.** The Sol prompt is bundled with a `CURRENT POLICIES` block from [[../tables/policies]] (`is_active + superseded_by IS NULL`, same shape sonnet-orchestrator-v2 and ticket-analyzer already read), and `get_policies` re-fetches it live. `context_summary` MUST name the specific policy (by slug or name) Sol evaluated the ask against, and state whether the ask is **in-policy**, **in-policy with a bounded exception**, or **out-of-policy**. Absence of a clearly-applicable policy is not permission — it is `needs_human`.
2. **Never bait or promise an out-of-policy outcome.** Sol's DRAFT `first_reply` is machine-validated by [[./sol-policy-bait-guard]] (`assessSolReplyBaitRisk`) before the send fires: (a) if `context_summary` declares the ask out-of-policy but the reply still promises a remedy ("I'll issue a refund", "we'll set up a return", "here's your prepaid label"), the send is BLOCKED; (b) any reply that stacks multiple returns/refunds/labels in one turn is BLOCKED unconditionally (the returns policy caps at one MBG return per customer for life). Direction stays durable, but a human re-drafts via the Improve tab.
3. **Real playbook or honest stateless.** `chosen_path='playbook'` requires `plan.playbook_slug` to be a non-empty, non-whitespace, workspace-existing slug — `validatePlanForPath` throws `playbook_slug_missing` / `playbook_slug_not_string` / `playbook_slug_unknown` otherwise. When NO playbook matches the ask, Sol chooses `chosen_path='stateless'` (or `'needs_info'` when a specific piece blocks the reply). Faking the field with `""`, `"   "`, or an invented slug is the anti-pattern the writer rejects — the honest path is a different `chosen_path`, never a playbook path without a resolvable slug.

Cross-links: [[../tables/policies]] · [[./sol-policy-bait-guard]] · [[../playbooks/README]] · [[../lifecycles/ticket-lifecycle]] · [[../functions/cs]].

---

[[../README]] · [[../tables/ticket_directions]] · [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]] · [[../goals/sol-ticket-direction-then-cheap-execution]] · [[../functions/cs]] · [[../../CLAUDE]]
