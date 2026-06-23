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

- **A retryable Anthropic failure THROWS — it does NOT fall back to "escalate".** `runOrchestratorDecision` previously funnelled *every* API error / network throw through `fallbackWithCancelRoute` (a generic escalate decision). During a Claude outage that silently degraded **every** ticket to escalation and let the host run "succeed", so the outage-spanning retry never kicked in. Now: a retryable status (429/5xx/529 — `isRetryableAnthropicStatus`) throws `AnthropicDependencyError`, and the top-level catch re-throws any retryable thrown error (`isRetryableThrownError`, incl. raw network failures) so the [[../inngest/unified-ticket-handler]] run retries across the outage. Terminal statuses (4xx≠429), parse failures, max-rounds, and missing-key still degrade to `fallbackWithCancelRoute` as before (fail-fast / graceful). See [[anthropic-retry]] · [[../specs/agent-outage-resilience]] Phase 1.
- The cached `system` prefix must stay below the cache-min only matters in reverse — it's well above the 4096-token (Opus) / 2048 (Sonnet) minimum, so it caches; but a workspace with almost no rules/policies could fall under and silently not cache (`cache_creation_input_tokens: 0`).
- Per-channel/personality variation fragments the system cache into a few entries per workspace (one per channel) — expected and fine.
- **Crisis overrides inventory_quantity in stock checks.** `inventory_quantity` can lag Shopify and read positive on a SKU that's really gone. Both `checkInventory` and `getProductKnowledge` therefore treat an **active `crisis_events` row** (status `active`) as authoritative: a variant matched by Shopify variant id (`affected_variant_id`, a Shopify id — not our UUID) → `affected_sku` → `affected_product_title` is forced OUT OF STOCK with its `expected_restock_date` inline, regardless of qty. Without this the orchestrator told a customer a crised Mixed Berry SKU (stale qty 3746) was back in stock and promised a reship that could never ship (ticket 9a7f9481). [[../tables/crisis_events]] · [[../orchestrator-tools]].
- **MARKETING CONSENT hint is conditional — never an unconditional "escalate".** In `getCustomerAccount`'s context builder (`~line 854`) the `MARKETING CONSENT:` line appends a hint only when it's actionable. A channel "has something to remove" only if its status is `subscribed` or `unknown`; `not_subscribed` means nothing is left to unsubscribe. The three cases: **(1)** no `shopify_customer_id` AND at least one channel still opted-in → a *platform-limitation* note ("an unsubscribe recorded here cannot be pushed to Shopify/external lists by an automated action; we can still record the opt-out internally and reply; only escalate if the customer needs removal from an external list we cannot reach") — deliberately **decoupled from the word "escalate"**. **(2)** no `shopify_customer_id` AND both channels already `not_subscribed` → "already fully unsubscribed … nothing left to remove; reply rather than escalate", with the empty-shell (`!subs.length && !orders.length`) variant adding "no orders and no subscriptions … any recurring charges the customer describes are not ours". **(3)** otherwise → no hint. The old code appended `[WARNING: … escalate so a human can remove from any external lists]` **unconditionally whenever `shopify_customer_id` was null**; that literal "escalate" in tool output over-rode every deterministic + `sonnet_prompt` rule and over-escalated already-unsubscribed empty shells (ticket 3d828685, Donald Owen — zero orders/subs, already `not_subscribed` on both channels). Per the **No-data-guard / Validate-validatable-claims / ground-truth-wins** rules the correct behavior for that shape is a reply, not an escalation. `subs` and `orders` are already in scope from the parallel fetch at the top of the builder.

---

[[../README]] · [[../../CLAUDE]]
