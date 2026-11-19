# required-outcome-policy

`src/lib/required-outcome-policy.ts` — the single, dependency-free definition of **"this required outcome is un-completable BY POLICY given the live target state."** Both ends of the uncompletable-policy-forbidden-required-outcome fix read this one rule so they can't drift.

## The incident (ticket `aaf00047`)

Sol authored an `apply_loyalty_coupon` [[../tables/ticket_required_outcomes]] row against a **paused** subscription (contract 57832276141). The active *"Loyalty redemption — don't recommend applying to a paused sub"* rule forbids it, and the apply handler fails it upstream with `subscription_not_active`. So the row sat in `status='failed'` **permanently** — the only path that clears a failed row ([[honor-required-outcomes]] `reconcileRequiredOutcomesForFiredActions`) needs a successfully-fired rescue action, which can **never** happen by policy. The [[outcome-completion-gate]] therefore re-escalated the fully-resolved ticket to June on every reopen (observed loop: June session ab590307 → customer thank-you → reopen → session 69d420cb). This is the uncovered sibling of the `cc78ad94` reconcile fix.

## Exports

| Symbol | Signature | Purpose |
|---|---|---|
| `COUPON_APPLY_KINDS` | `ReadonlySet<string>` | The coupon/loyalty APPLY kinds that require an ACTIVE sub: `apply_loyalty_coupon`, `apply_coupon`. |
| `couponApplicableToSubStatus(status)` | pure | `status === "active"`. One-line **mirror** of the same-named fn in [[subscription-items]] — re-defined here (not imported) so this module stays dependency-free; keep them in sync. |
| `assessPolicyForbidden(kind, subStatus)` | pure | The rule. Returns `{forbidden:true, reason}` when `kind ∈ COUPON_APPLY_KINDS` AND `subStatus` is positively non-active. Fail-closed: `subStatus == null` (unreadable / no contract) → `{forbidden:false}` — never auto-act on absent evidence. |

## The two halves this rule feeds

- **PREVENT** — [[required-outcomes-validator]] `validateRequiredOutcomes` rejects a coupon-apply item whose target sub is non-active with reason `subscription_not_active`, so the un-completable row is **never authored**.
- **WAIVE** — [[outcome-completion-gate]] `waivePolicyForbiddenOutcomes` marks an already-stuck `pending`/`failed` coupon-apply row `waived` when its target sub is non-active, so the gate stops re-escalating a **correctly-NOT-done** outcome. Wired into [[../inngest/unified-ticket-handler]]'s `message_sent` branch, run right before the completion-gate assessment.

## Invariants

- **One rule, two readers.** A new policy-forbidden case is added HERE (and covered by a test), then both the validator and the gate inherit it. Don't hand-roll the predicate in either caller.
- **Fail-closed on absent evidence.** The block/waive fires only when we positively observe a non-active sub. A missing `contract_id` or an unreadable sub leaves the row open for a human — we never waive/block on a guess.
- **Pure + import-free.** No Supabase, no [[subscription-items]] import — so the validator and gate can share it without pulling heavy module graphs, and the rule is answerable by a static grep.

## Related

- [[../tables/ticket_required_outcomes]] — the `waived` terminal-closed status this rule drives.
- [[required-outcomes-validator]] (PREVENT) · [[outcome-completion-gate]] (WAIVE) · [[honor-required-outcomes]] (the reconcile sibling).
- [[../tables/subscriptions]] — `status` is lowercase `active | paused | cancelled`.
