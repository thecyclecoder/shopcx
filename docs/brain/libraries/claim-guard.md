# `src/lib/claim-guard.ts`

Deterministic **claim↔action binding** guard. Answers one question about an outbound customer message: *does it assert we already did something (refund / cancel / pause / coupon / return / order / swap / date / address) that no verified action backs?*

This is the pre-send half of execution verification — the cheapest, highest-ROI fix from the execution-verification forensics: **~half** of all `broken_action` / `false_promise` grader issues are "Category C" — the model writes "I've refunded you" as prose while attaching **no action**, so nothing reaches the verifier and the false claim ships. The guard is pure + deterministic (no I/O, no model) and **fail-safe**: callers escalate on a hit rather than send.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `unbackedEffectClaim` | `(message: string \| null \| undefined, backed: Set<string>) => string \| null` | Returns the effect the message claims as done-but-unbacked, or `null`. `backed` = action families that ran+verified in this decision; pass an **empty set** for no-action paths (any completed-effect claim is then unbacked). |
| `EFFECT_PATTERNS` | `EffectPattern[]` | The `{ effect, families, re }` table. Each `re` requires a first-person/passive **completed** framing (`I/we ('ve\|have) [filler] <verb> <object>` or `your <noun> has been <verb>`); the object is pinned to the effect noun so generic verbs can't over-trip. |
| `EffectPattern` | `{ effect: string; families: string[]; re: RegExp }` | — |

Conservative by design: does **not** trip on offers ("I can refund you"), questions ("would you like me to cancel?"), future intent ("I'll process that"), the customer's own action ("you cancelled…"), or generic verbs on unrelated objects ("I've processed your request").

## Callers

- [[action-executor]] `executeSonnetDecision` — `kb_response` / `ai_response` case: before sending `response_message` (a path that attaches no actions), any hit → `sysNote` + `escalateTicket(ctx, "blocked_unbacked_claim:<effect>")` instead of sending. Phase 1 will extend the check to the `direct_action` send with the verified action families as `backed` (catches "claimed refund, only ran a date change").

## Tests

`src/lib/claim-guard.test.ts` (node:test) — pins the block cases (completed first-person/passive claims), the allow cases (offers/questions/future/customer-action/unrelated), and the backing-action exemption. Run: `npx tsx --test src/lib/claim-guard.test.ts`.

## Provenance

Phase 0 of the "guaranteed, observable, self-running ticket handling" goal (Milestone A — Truthful actions).
