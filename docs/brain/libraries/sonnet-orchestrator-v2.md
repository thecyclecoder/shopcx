# libraries/sonnet-orchestrator-v2

The brain. Tool-use orchestrator that picks an action_type per inbound message. Loads on-demand data via tool calls (get_customer_account, get_returns, get_crisis_status, check_inventory, etc.). Returns a `SonnetDecision` JSON the action executor dispatches. Full tool catalog: [[../orchestrator-tools]].

**File:** `src/lib/sonnet-orchestrator-v2.ts`

## File header

```
Sonnet Orchestrator v2 — Tool Use
Instead of pre-loading all context, Sonnet gets minimal pre-context + tools
to fetch data on demand. Two-bucket reasoning: account data vs product knowledge.
Crisis is just another data tool, not a separate code path.
Data-only tools — actions stay in SonnetDecision → action executor flow.
```

## Exports

### `executeToolCall` — function

```ts
async function executeToolCall(name: string, input: Record<string, unknown>, workspaceId: string, customerId: string, _ticketId: string,) : Promise<string>
```

### `callSonnetOrchestratorV2` — function

```ts
async function callSonnetOrchestratorV2(workspaceId: string, ticketId: string, customerId: string, message: string, channel: string, personality?: { name?: string; tone?: string; sign_off?: string | null } | null, agentContext?: { assigned: boolean; intervened: boolean } | null, modelChoice?: { model: OrchestratorModelKey; reason: string } | null,) : Promise<SonnetDecision>
```

### `SonnetDecision` — interface

### `OrchestratorModelKey` — type

## Callers

- `src/lib/improve-tools.ts`

## Prompt caching (cost-critical)

`buildPreContext` returns **`{ system, userBlock }`** — a deliberate split for prompt caching (the orchestrator is ~98% of all AI spend, and input context dwarfs output ~184:1):

- **`system`** — the heavy, **workspace-stable** payload (role line, tool-usage note, AVAILABLE HANDLERS, PERSONALITY, POLICIES, prompt RULES, output schema). Sent as a `system` block with a **1-hour cache breakpoint** (`cache_control: {type:"ephemeral", ttl:"1h"}`, beta header `extended-cache-ttl-2025-04-11`). The last tool also carries a 1h breakpoint (tools render before system). Byte-identical across every ticket in the workspace (modulo channel/personality), so the first ticket each hour writes it and **every subsequent ticket / AI turn / tool-use round reads it at 0.1×**.
- **`userBlock`** — **volatile** per-ticket/per-turn content (`currentDateContext()`, CUSTOMER, language, TICKET subject/tags/playbook/page/agent, AGENT GUIDANCE, CONVERSATION). Sent **uncached** in `messages[0]`. Keeping the date + conversation here is what lets the system prefix stay stable.

**Hard rule: never move per-ticket, per-turn, or per-call content into `system`.** Caching is a prefix match — one volatile byte in the system block invalidates the shared prefix for the whole workspace. That was the pre-2026-06 leak: the entire prompt was one user block with the customer + conversation *ahead* of the rules, so the ~60K stable payload re-billed at full freight on every ticket (`cache_creation ≈ cache_read`, only ~36% reads). The split + 1h TTL converts the bulk of cache-creation tokens into reads. Handler queries (`journey_definitions`/`playbooks`/`workflows`) carry `.order("name")` so the rendered list is byte-stable. **Verify after deploy:** `cache_read_input_tokens` share in [[ai-usage]] / [[../tables/ai_token_usage]] should climb well above the prior ~36%.

## Control Tower heartbeat (`ai:orchestrator`)

`callSonnetOrchestratorV2` is a registered **inline-agent** in the Control Tower ([[../specs/control-tower-agent-coverage]] Phase 2, [[control-tower]]). It wraps the inner `runOrchestratorDecision` in a try/finally and emits exactly **one `loop_heartbeats` beat per run** (`loop_id='ai:orchestrator'`, `kind='inline-agent'`, via `emitInlineAgentHeartbeat`):

- **ok** — `false` when the run threw OR returned a **degraded/fallback** decision (no API key, API error, max-rounds, parse fail — every error path funnels through `fallbackWithCancelRoute`, which tags its result in a module `WeakSet<SonnetDecision>`). A real model decision — **including a model-chosen `escalate`** — is `ok:true`. This is what lets the error-rate assertion catch an orchestrator that "ran" but parse-fails/errors on every ticket.
- **produced** — `{ action_type, handler_name, model }`.
- **detail** — `decided: <action_type>` · `degraded: <reasoning…>` · `threw: <message>`.

The monitor's **work-exists** probe for this loop is inbound customer messages (`ticket_messages` `direction='inbound'`, `author_type='customer'`) in the 2h window — inbound traffic with 0 successful decision beats ⇒ the per-ticket decision agent went silent. The heartbeat write is best-effort and never affects the returned decision.

## Gotchas

- The cached `system` prefix must stay below the cache-min only matters in reverse — it's well above the 4096-token (Opus) / 2048 (Sonnet) minimum, so it caches; but a workspace with almost no rules/policies could fall under and silently not cache (`cache_creation_input_tokens: 0`).
- Per-channel/personality variation fragments the system cache into a few entries per workspace (one per channel) — expected and fine.

---

[[../README]] · [[../../CLAUDE]]
