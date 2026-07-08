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

- [[../inngest/unified-ticket-handler]] — the pre-`stampedSend` gate (Phase 2 of the spec, still to be wired). On `kind !== 'none'` the drafted reply is NOT shipped; a `ticket_resolution_events` row is staged with `reasoning='sol:inflection-<kind>'` and the re-session router in Phase 3 supersedes the Direction and re-enqueues Sol.

## Evidence → ledger

The `evidence` object is stamped verbatim into `ticket_resolution_events.reasoning` prefixed with `sol:inflection-<kind>` when the gate fires. That prefix is what the verification suites for Phases 2 and 3 assert.

## Related

- [[../specs/sol-drift-frustration-detector-and-re-session-router]]
- [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]]
- [[../specs/sol-cheap-execution-over-ticket-direction]]
- [[./ticket-directions]] — the durable Direction artifact whose `intent` this detector reads.
- [[../tables/ticket_resolution_events]] — where the flagged reasoning lands.
- [[../tables/ai_channel_config]] — `ai_turn_limit` + (Phase 3) `sol_frustration_holding_message_enabled`.
- [[../lifecycles/ticket-lifecycle]] — § Phase 2b (Sol first-touch dispatch) + § Phase 2f (executor / write-ahead ledger).
