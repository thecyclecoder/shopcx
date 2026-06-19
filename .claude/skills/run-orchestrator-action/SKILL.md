---
name: run-orchestrator-action
description: Use to invoke a runtime orchestrator action (apply_coupon / refund / pause / resume / return / loyalty / cancel-via-journey …) from a one-off ShopCX script — the layer-1 bridge that drives the SAME executeSonnetDecision / directActionHandlers code path production uses, no freestyle DB writes. Triggered by "re-run the {action} the AI failed to land" or "apply {action} to {customer} through the real executor". Maps to apply-coupon-via-executor.ts.
---

# run-orchestrator-action

The **layer-1 bridge.** Runtime orchestrator actions (pause/resume/refund/return/coupon/loyalty/cancel-via-journey/replies) are what the AI does *live* during customer service — they live as `directActionHandlers` in `src/lib/action-executor.ts`, dispatched by `executeSonnetDecision`. When you need to re-run one from a script (the original Sonnet run hit a 4xx, or an operator wants to land it deliberately), drive it through that **same** executor — never hand-roll the Appstle/Shopify/DB calls, or you'll diverge from production (skip the logging, the response message, the escalation-on-failure, the idempotency).

## Procedure

1. **Scaffold a script** (this is also a [[customer-remedy]] when it's resolving one customer end-to-end). Standard [[script-conventions]] bootstrap + `createAdminClient()`. Resolve the customer/ticket/contract by **UUID** (internal joins use UUIDs, never `shopify_*_id`).
2. **Fetch + assert state first.** Read the live row (sub status, existing `applied_discounts`, etc.) and bail if the precondition isn't met (`sub.status !== "active"` → abort). The executor assumes a sane starting state.
3. **Build a `SonnetDecision`, not raw writes.** Shape it exactly like production:
   ```ts
   const { executeSonnetDecision } = await import("../src/lib/action-executor");
   const decision = {
     reasoning: "Operator-triggered re-attempt after the original run hit Appstle 400. …",
     action_type: "direct_action" as const,
     actions: [{ type: "apply_coupon", contract_id, code }],
     response_message: responseTemplate,   // what the customer sees — plain text, ≤2 sentences/para
   };
   ```
4. **Pass the live context + send/sys callbacks.** `executeSonnetDecision({ admin, workspaceId, ticketId, customerId, channel, sandbox: false }, decision, null, sendFn, sysNoteFn)`. `sendFn` posts the outbound message (e.g. insert a `ticket_messages` `author_type:'ai'` row for a chat ticket so the widget polls it); `sysNoteFn` writes the internal audit note. The executor calls them — you don't post the reply yourself.
5. **Gate on `--apply`; dry-run prints the decision.** Without `--apply`, print the `SonnetDecision` you *would* run and exit. With `--apply`, run it, then **verify the outcome** by re-reading the row (`applied_discounts` now non-empty / sub paused / refund logged) and check `result.escalated` — escalation means the underlying action still failed and the ticket stays open.
6. **Run:** `npx tsx scripts/{action}-via-executor.ts {who}` (dry) → `… {who} --apply`.

## Guardrails

- **Same code path, no freestyle.** The whole point is to go *through* `executeSonnetDecision` → `directActionHandlers` so behavior, logging, and escalation match production. Never reach past it to write Appstle/Shopify/Supabase directly for an action a handler already owns.
- **Idempotent + verify-after.** Re-check state before and after; money-affecting actions (refund/credit/charge) must never double-apply. `result.escalated` or an unchanged row = it didn't land — surface it, don't claim success.
- **Don't skill-ify each action.** There are ~20 customer-action recipes documenting individual handlers; this skill is the *bridge pattern* for invoking any of them from a script — not one skill per action ([[../../../docs/brain/specs/repo-skills-catalog|spec]] layer-1 vs layer-2).
- **`sandbox: false` hits real systems.** Keep it `true`/dry until you mean it.
- **No prod creds under the box worker.** Author the script; an `--apply` run mutates prod → request approval (`{"type":"run_prod_script","cmd":"npx tsx scripts/{action}-via-executor.ts {who} --apply"}`) and stop. Locally/interactively run directly.

## Related
`scripts/apply-coupon-via-executor.ts` · `src/lib/action-executor.ts` (`executeSonnetDecision`, `directActionHandlers`) · skills: `customer-remedy`, `script-conventions`, `fire-inngest-event` · `docs/brain/libraries/action-executor.md` · `docs/brain/recipes/apply-coupon.md`
