# anthropic

Anthropic — Claude (Haiku + Sonnet + Opus). THE language model for the entire platform: orchestrator decisions, agent responses, journey AI conversations, remedy selection, review summaries, ticket analysis, fraud-rule fuzzy matching, every AI surface.

## Auth

- **Env only:** `ANTHROPIC_API_KEY` (account-level)

No per-workspace credentials. Per-workspace AI behavior is controlled via [[../tables/ai_channel_config]] + [[../tables/ai_personalities]] + [[../tables/sonnet_prompts]] + [[../tables/policies]] + [[../tables/macros]], not credentials.

## SDK

Uses the official `@anthropic-ai/sdk` npm SDK. Wrapped + model-selected by `src/lib/ai-models.ts` + `src/lib/model-picker.ts`.

## Models in use

| Model ID | Used for |
|---|---|
| `claude-haiku-4-5-20251001` | Cheap fast turns: AI turns 1-2, remedy selection, review summarization (max 15 words), fraud fuzzy-match, smart-pattern fallback, journey suggestion detection, social-comment classification |
| `claude-sonnet-4-6` | Main orchestrator + AI turns 3+ + open-ended cancel chat (max 3 turns) + crisis decisions + playbook-step decisions |
| `claude-opus-4-7` | Reserved for deep ticket-analysis runs + research-and-heal pipeline |

Model id constants live in `src/lib/ai-models.ts`. **Don't hardcode strings elsewhere** — bump the constant when models change.

## Key features we use

| Feature | Where | Why |
|---|---|---|
| **Tool use** | Sonnet orchestrator v2 | Sonnet calls data tools (`get_customer_account`, `get_returns`, `get_crisis_status`, etc.) on demand instead of pre-loading everything. See [[../lifecycles/ai-multi-turn]]. |
| **Prompt caching** | Every orchestrator + agent turn | Customer-facing prompts are stable across turns within a ticket — caching cuts cost ~70% on multi-turn flows. Cache breakpoints set at the boundary between stable system prompt + dynamic per-turn context. |
| **Streaming** | None in prod | Customer-facing UI doesn't stream — we batch and send via `pending_send_at` for delivery-delay control. |
| **JSON mode** | Sonnet orchestrator decision output | Output must be valid `SonnetDecision` JSON. |
| **Vision** | None in prod | Future: product-image analysis. |

## Rate limits + retry

- RPM / TPM depend on org tier. We track usage in [[../tables/ai_token_usage]] (model, input/output/cache tokens, cost, latency).
- SDK retries on 429 + 5xx with exponential backoff (built-in, ~3 attempts).
- 529 (overloaded) is special-cased — see project_ticket_glitch_apr13: must surface gracefully, never silently fall through to default behavior.

## Token accounting

Every call writes to [[../tables/ai_token_usage]]:
- `model` — model id used
- `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
- `cost_usd_cents` — computed from per-model pricing
- `latency_ms`
- `workspace_id`, `ticket_id` (when known)

Drives the AI usage dashboard. **Always pass workspace_id + ticket_id** through `src/lib/ai-usage.ts` so token costs are attributable.

## Model selection rules

`src/lib/model-picker.ts` decides per call:
- Turn 1-2 on a customer-facing AI response → Haiku
- Turn 3+ or escalation-required → Sonnet
- Pattern classifier fallback → Haiku
- Remedy selection (cancel journey) → Haiku
- Open-ended cancel chat → Sonnet
- Crisis decisions → Sonnet
- Research-and-heal deep investigation → Opus (cost OK — runs nightly + on-demand only)

## Gotchas

- **Don't import the SDK outside `src/lib/ai-models.ts`** + `src/lib/ai-usage.ts`. Centralizing keeps the model upgrade path simple and ensures token accounting hits every call.
- **Prompt caching has a 5-min TTL.** Multi-turn AI conversations re-use cache if turns are close together; long-paused tickets blow the cache. The orchestrator wakes-up math assumes warm cache.
- **JSON output is not guaranteed valid.** Validate with `safeJSONParse()` (`src/lib/sonnet-orchestrator-v2.ts`) and have a fallback (typically escalate to human).
- **Cost spikes are usually cache misses.** Check `cache_read_input_tokens` vs `input_tokens` ratio in [[../tables/ai_token_usage]] — should be > 0.5 in steady state.
- **AI must read `agent_intervened` first** on every turn — if a real human sent a message, AI behavior must shift (no auto-resolve, deferential tone). See feedback_ai_response_quality.
- **Never tell customers the AI is the AI.** Personality config in [[../tables/ai_personalities]] — "Suzie" is our brand. See feedback_customer_signoff_persona + feedback_ai_human_touch.
- **AI outputs are plain text, no markdown** for customer-facing channels. Mirror the customer's language. Max 2 sentences per paragraph. See feedback_ai_response_quality.

## Files

- `src/lib/ai-models.ts` — Model id constants + SDK client
- `src/lib/ai-usage.ts` — Token accounting (writes [[../tables/ai_token_usage]])
- `src/lib/model-picker.ts` — Per-call model selection logic
- `src/lib/sonnet-orchestrator-v2.ts` — Main orchestrator with tool use
- `src/lib/action-executor.ts` — Executes orchestrator decisions
- `src/lib/ai-context.ts` — Pre-loaded context for orchestrator
- `src/lib/remedy-selector.ts` — Cancel journey AI (Haiku for selection, Sonnet for open chat)
- `src/lib/ticket-analyzer.ts` — Per-ticket analysis runs
- `src/lib/pattern-matcher.ts` — 3-layer classifier (Haiku is layer 3)
- `src/lib/social-comment-orchestrator.ts` — Social comment AI
- `src/lib/playbook-executor.ts` — Playbook-step AI decisions

## Related

[[../tables/ai_token_usage]] · [[../tables/ai_channel_config]] · [[../tables/ai_personalities]] · [[../tables/ai_workflows]] · [[../tables/sonnet_prompts]] · [[../tables/policies]] · [[../tables/macros]] · [[../tables/smart_patterns]] · [[../tables/ticket_analyses]] · [[../tables/knowledge_gaps]] · [[../tables/grader_prompts]] · [[openai]] · [[../inngest/unified-ticket-handler]] · [[../inngest/ai-nightly-analysis]] · [[../inngest/ticket-research]]
