# libraries/inflection-detector

The per-turn "does the current Direction still fit?" gate that runs BEFORE `stampedSend` fires on every cheap-execution turn ([[../specs/sol-drift-frustration-detector-and-re-session-router]] · [[../lifecycles/ticket-lifecycle]] § Phase 2b). Two-stage classifier: cheap regex + counter rules first, one Haiku ([[../integrations/anthropic]]) call only on the ambiguous `'maybe'` outcome. Frustration always wins over drift — highest-value trigger, no confidence override.

**File:** `src/lib/inflection-detector.ts` · **Tests:** `src/lib/inflection-detector.test.ts`

## Contract

```ts
type InflectionKind = "none" | "drift" | "frustration";

interface InflectionResult {
  kind: InflectionKind;
  evidence: {
    stage: 1 | 2;
    reason: string;             // stamped verbatim into ticket_resolution_events.reasoning
    cues?: string[];
    turn_index?: number;
    ai_turn_limit?: number;
    drift_score?: number;
    playbook_exceptions_incremented?: boolean;
    haiku_verdict?: { kind: InflectionKind; reason: string } | null;
  };
}

async function detectInflection(input: {
  direction: { intent: string; authored_at: string } | null;
  newestMessage: string;
  recentTurns: Array<{ reasoning: string | null }>;
  turnIndex: number;
  aiTurnLimit: number;
  isPlaybookActive: boolean;
  playbookExceptionsIncrementedSinceDirection: boolean;
  haiku?: HaikuVerdictFn;   // injected for tests; defaults to the real Anthropic call
}): Promise<InflectionResult>;
```

## Stage 1 — rule catalog

### Frustration cues (regex, first match wins the label)

| cue id | pattern (case-insensitive) | example |
|---|---|---|
| `refund_now` | `\brefund\s+(?:me\s+)?(?:now|immediately|asap|right\s+now)\b` | "refund me now" |
| `cancel_everything` | `\bcancel\s+(?:everything|it\s+all|the\s+whole\s+thing|all\s+of\s+it)\b` | "cancel everything" |
| `this_is_ridiculous` | `\bthis\s+is\s+(?:ridiculous|absurd|insane|unacceptable|outrageous)\b` | "this is ridiculous" |
| `sue_you` | `\b(?:i(?:'m\|\s+am)\s+going\s+to\s+sue|see\s+you\s+in\s+court|small\s+claims)\b` | "see you in court" |
| `chargeback` | `\b(?:i(?:'m\|\s+am)\s+)?(?:going\s+to\s+)?(?:file(?:\s+a)?\|do\s+a\|dispute\s+with\|open\s+a)?\s*charge\s*back(?:s)?\b` | "chargeback", "file a chargeback" |
| `worst_service` | `\b(?:worst\|terrible\|awful\|garbage)\s+(?:customer\s+)?(?:service\|support\|company)\b` | "worst customer service" |
| `stop_scamming` | `\b(?:stop\s+)?(?:scam(?:ming)?\|rip(?:ping)?\s+me\s+off\|fraud)\b` | "stop scamming me" |
| `give_up` | `\b(?:i\s+give\s+up\|i(?:'m\|\s+am)\s+done\|forget\s+it)\b` | "I'm done" |
| `speak_to_human` | `\b(?:speak\|talk)\s+to\s+(?:a\s+)?(?:human\|manager\|supervisor\|real\s+person)\b` | "let me speak to a manager" |
| `wtf` | `\b(?:wtf\|what\s+the\s+(?:f\*+\|fuck\|hell))\b` | "wtf" |

Plus two shape signals:

- `repeated_punct` — `[!?]{3,}` — "???" or "!!!" (or longer).
- `all_caps` — letters-only caps ratio ≥ `0.7` on messages with ≥ `20` letters (below the letter floor, "OK" or "USPS" would false-fire).

Any cue hit ⇒ `kind='frustration'` immediately. Frustration wins ties: it runs BEFORE the drift arm, so a "refund me now, actually change my flavor" registers as frustration (per spec: "frustration always wins over drift when both fire").

### Checkout-stuck signal

(Part of [[../recipes/checkout-stuck-concierge-flow]].) Runs AFTER the frustration arm (so frustration still wins) but BEFORE the playbook-active skip and the drift-score arm — a customer stuck at the Shopify checkout must flag Sol back in even mid-playbook and even without a live Direction. Uses [[checkout-stuck-intent]] `classifyCheckoutStuck` on `newestMessage`; on match, returns `kind='drift'` with `evidence.reason='stage1_checkout_stuck'` and `evidence.cues=[<winning cue id>]`, so the existing `reSessionSol` router supersedes the live Direction and enqueues a new `kind='ticket-handle'` `agent_jobs` row for Sol to author a real assisted-purchase Direction.

### Drift signals

Evaluated ONLY when Stage 1 didn't flag frustration. **Skipped entirely when `isPlaybookActive`** — mid-playbook the reply comes from the playbook step, not from Direction alignment (per spec).

1. **`drift_keyword_mismatch`** — content-token miss between `direction.intent` and (newest message + last two turns' reasoning). Stopwords stripped; tokens ≥ 3 chars. `mismatch = missing / |intent tokens|`. Threshold `0.8` (a fully-relevant follow-up like "what's the tracking number?" on a "shipping-delay" intent stays under; a topic pivot clears it).
2. **`turn_limit_approach`** — `turn_index >= 0.8 * ai_turn_limit` — the conversation is running out of room and the current Direction hasn't landed.
3. **`playbook_exception_incremented`** — `tickets.playbook_exceptions_used` was incremented since `direction.authored_at`. The caller resolves this cheaply from `tickets` + the direction row.

**Aggregation.** ≥ 2 signals ⇒ `kind='drift'` (definite). Exactly 1 signal ⇒ `kind='maybe'` (escalate to Stage 2). Zero signals ⇒ `kind='none'`.

## Stage 2 — Haiku fallback (`'maybe'` only)

Model: [[../integrations/anthropic]] `HAIKU_MODEL` ([[./ai-models]]). `max_tokens: 200`.

`detectInflection` NEVER calls Stage 2 on Stage 1 `'none'` or definite `'drift'`/`'frustration'` — that is the whole point of the rule catalog. When Direction is null on a `'maybe'`, Stage 2 also collapses to `'none'` (no intent to reason against; a bounce with no evidence is worse than letting the current session finish).

### System prompt (verbatim — `STAGE_2_SYSTEM_PROMPT`)

```
You are a support-triage classifier. Given the current ticket Direction's intent, the
newest inbound customer message, and the two most recent orchestrator turns, decide whether
the conversation has DRIFTED off the current intent, whether the customer is showing
FRUSTRATION, or NEITHER. Frustration outweighs drift when both are present.

Return STRICT JSON only, no prose, matching:
  {"kind": "none" | "drift" | "frustration", "reason": "one short sentence"}
```

### User prompt shape

```
Direction.intent: <intent>

Last two orchestrator turns (newest first):
  1. <reasoning-N>
  2. <reasoning-N-1>

Newest customer message: <newestMessage>
```

### Failure semantics

- Missing `ANTHROPIC_API_KEY`, non-2xx response, or malformed JSON ⇒ Haiku returns `null` ⇒ caller collapses `'maybe'` to `'none'` with `evidence.reason='haiku_unavailable_fallback_none'`. A transient Anthropic outage NEVER fabricates a bounce.
- Optional \`\`\`json fences on the model's response are stripped before `JSON.parse`.

## Call sites

- [[../inngest/unified-ticket-handler]] — the pre-`stampedSend` gate (Phase 2 of the spec, still to be wired). On `kind !== 'none'` the drafted reply is NOT shipped; a `ticket_resolution_events` row is staged with `reasoning='sol:inflection-<kind>'` and the re-session router (see `reSessionSol` below) supersedes the Direction and re-enqueues Sol.

## Evidence → ledger

The `evidence` object is stamped verbatim into `ticket_resolution_events.reasoning` prefixed with `sol:inflection-<kind>` when the gate fires. That prefix is what the verification suites for Phases 2 and 3 assert.

## `reSessionSol` — Phase 3 router

The mutating primitive the Phase-2 gate calls on a `'drift'` or `'frustration'` verdict.

```ts
async function reSessionSol(
  admin: SupabaseClient,
  ticket_id: string,
  input: {
    workspace_id: string;
    channel: string; // ai_channel_config lookup for sol_max_resessions
    kind: "drift" | "frustration";
    evidence: InflectionEvidence;
    turn_index?: number;
  },
): Promise<{
  superseded: boolean;
  enqueued: boolean;
  superseded_direction_id: string | null;
  job_id: string | null;
  cap_hit: boolean; // Phase 2 of sol-runaway-re-session-cap-guardrail
}>;
```

Four mutations, gated on a cap check (Phase 2 of [[../specs/sol-runaway-re-session-cap-guardrail]]):

1. **Load the live Direction + `ai_channel_config.sol_max_resessions`.** No live row → the router distinguishes two cases via a `hasActiveTicketHandleJob` dedup probe (reads `agent_jobs` for `(workspace_id, spec_slug='ticket-handle-<first8>', status IN ACTIVE_STATUSES)` — the same [[./agent-jobs]] `ACTIVE_STATUSES` set the box worker treats as in-flight):
   - **Genuine no-Direction** (nothing ever authored — a pre-Sol legacy ticket, or a first-touch enqueue that never landed) with NO active ticket-handle job → **enqueue a fresh first-touch-shaped `ticket-handle` `agent_jobs` row** with `instructions = {ticket_id, workspace_id, turn_index, reason:'inflection', kind, evidence, superseded_direction_id:null}` and stamp a best-effort `ticket_resolution_events` row with `reasoning='sol:resession-no-direction'` + `chosen={kind, fallback:'first_touch_no_live_direction'}` for observability. Returns `enqueued:true`, `superseded:false`, `job_id` non-null. Runaway is bounded: the fresh session authors a Direction on first-touch (or escalates on a rail-hit), after which later inflections flow through the normal capped path (steps 2-6, `sol_max_resessions`). This closes the [[../specs/sol-resession-enqueue-first-touch-when-no-live-direction]] silent-drop that stranded a frustrated ticket after the "we're looking into that for you" holding message had already been sent.
   - **True concurrent race** (an active ticket-handle job is already in flight for this ticket) → early return (`superseded:false`, `enqueued:false`, `cap_hit:false`). The dedup guard caps concurrency at one in-flight session per ticket and prevents the fallback from fanning out a duplicate.
2. **Cap check.** `sol_max_resessions IS NOT NULL AND resession_count >= sol_max_resessions` → **skip supersede AND agent_jobs insert**. Instead:
   - `UPDATE tickets SET escalated_at=now(), escalated_to=null, escalation_reason='sol_resession_cap_hit'` — workspace-scoped compare-and-set + `.select('id')` so a cross-workspace ticket_id collision can't cross the boundary. Routine lane (`escalated_to IS NULL`) is picked up by [[../inngest/triage-escalations]] under the "AI Investigation" badge per [[../lifecycles/ticket-lifecycle]] § Escalation lifecycle.
   - Stamp one `ticket_resolution_events` row with `reasoning='sol:cap-hit'` + `chosen={resession_count, sol_max_resessions, kind}` — Phase 3 of this spec reads that filter for the analytics tile + cs-director-digest.
   - Return `cap_hit:true` (else branches all set `cap_hit:false`). `sol_max_resessions IS NULL` = uncapped — the cap branch NEVER fires regardless of `resession_count`.
3. **Increment `resession_count`** on the live Direction via [[./ticket-directions]] `incrementResessionCount` — compare-and-set on `(id, workspace_id, superseded_at IS NULL)` + `.select('id')` so a racing supersede returns `null` and the router bails without double-counting.
4. **Supersede the live Direction** via [[./ticket-directions]] `superseDirection` (workspace-scoped compare-and-set on `superseded_at IS NULL`). If a racing caller stamped it first, `superseDirection` returns `null` — the router bails without enqueueing so we don't fan out a redundant `ticket-handle` session. The DB-level partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL` on [[../tables/ticket_directions]] is a second belt guaranteeing exactly one live row per ticket at any moment.
5. **Enqueue a new box session.** One `agent_jobs` row `kind='ticket-handle'`, `spec_slug='ticket-handle-<first 8 of ticket_id>'` (mirrors first-touch for worker routing uniformity), `status='queued'`, `instructions = JSON.stringify({ticket_id, workspace_id, turn_index, reason:'inflection', kind, evidence, superseded_direction_id})`. `runTicketHandleJob` reads `reason='inflection'` to know it's a bounce (vs `'first_touch'`) and links the new Direction back to `superseded_direction_id` in the ledger.

### The router NEVER sends a customer-facing message

Per spec: the corrected reply is the new box session's job — writing it from the router would put two messages on the ledger for one inflection turn, breaking the "one Direction per intent" invariant [[../specs/sol-cheap-execution-over-ticket-direction]] relies on. The optional holding-message send lives at the Phase-2 gate call site (see below), NOT here.

### Holding message on `'frustration'` (gate-site policy, not router)

The Phase-2 gate call site — BEFORE it calls `reSessionSol` — sends a short "we're looking into that for you" inline holding message via `stampedSend` when:

- `kind === 'frustration'` (drift is silent by default — the customer doesn't need to be told the AI is re-orienting).
- `ai_channel_config.sol_frustration_holding_message_enabled` is `true` (default `true`, workspace-tunable — a workspace that prefers a fully silent re-session can turn it off). Migration: `supabase/migrations/20260928120000_ai_channel_config_sol_frustration_holding_message_enabled.sql` (`boolean NOT NULL DEFAULT true`), applied via `scripts/apply-ai-channel-config-sol-frustration-holding-message-enabled-migration.ts`.

## Related

- [[../specs/sol-drift-frustration-detector-and-re-session-router]]
- [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]]
- [[../specs/sol-cheap-execution-over-ticket-direction]]
- [[./ticket-directions]] — the durable Direction artifact whose `intent` this detector reads and whose `superseDirection` the router calls.
- [[../tables/ticket_directions]] — one live row per ticket (partial UNIQUE `superseded_at IS NULL`).
- [[../tables/ticket_resolution_events]] — where the flagged `sol:inflection-<kind>` reasoning lands.
- [[../tables/ai_channel_config]] — `ai_turn_limit` + `sol_frustration_holding_message_enabled`.
- [[../lifecycles/ticket-lifecycle]] — § Phase 2b (Sol first-touch dispatch + re-session bounce) + § Phase 2f (executor / write-ahead ledger).
