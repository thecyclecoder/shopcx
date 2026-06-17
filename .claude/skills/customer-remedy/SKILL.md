---
name: customer-remedy
description: Use to resolve ONE customer's situation end-to-end via a one-off script — refund, subscription repair, recovery sub, payment-method fix, identity relink, loyalty correction. The genre of scripts/_jay-*, _michelle-*, cheryl-*, brad-* and run-refund-playbook / setup-mary-recovery-sub. Triggered by "fix {customer}'s {problem}" where it spans multiple steps/systems.
---

# customer-remedy

Handle a single customer's multi-step fix as a logged, idempotent, dry-run-first script that executes through ShopCX's existing action layer — never by hand-rolling Appstle/Shopify/Braintree calls.

## Procedure

1. **Create** `scripts/{customer-or-scenario}-{ticketshort}.ts` (e.g. `restart-brad-coffee-sub-d31f8183.ts`). Use the standard bootstrap + `createAdminClient()` (see the `probe-db` skill).
2. **Resolve identities by UUID** — customer, subscription, order. **Never** key off `shopify_*_id` for relationships (Shopify is being sunset). Resolve linked accounts via the customer-links group where relevant.
3. **Fetch + print current state first** (a probe step) so the log shows the starting point before any mutation.
4. **Plan gated steps.** List the steps as code with a guard between each — abort early if a critical step fails (e.g. don't deduct loyalty if the refund didn't settle).
5. **Execute through the action layer.** Use `directActionHandlers` from `src/lib/action-executor.ts` (the same vocabulary the orchestrator uses: `partial_refund`, `create_return`, `remove_item`, `pause_timed`, `apply_coupon`, …) rather than calling integrations directly. This inherits the money-safety + idempotency + tax-void guarantees the recipes document.
6. **Log every gate** with input → output, and a final success/failure summary per step (for manual verification).
7. **Dry-run first.** Support a `--apply` flag; default to printing the plan + current state without mutating. Only mutate when `--apply` is passed.
8. **Run:** `npx tsx scripts/{name}.ts` (review) then `… --apply` (execute).

## Guardrails

- **Idempotent** — re-running after a partial failure must not double-charge, double-refund, or double-grant. Check state before each mutation.
- **Fraud gate** — confirm the customer isn't fraud/chargeback-flagged before granting money or relinking identities.
- **Refunds tied to returns** flow through the return pipeline (don't call a raw refund for a return — `create_return` drives `net_refund_cents`).
- **Cancel requests** go through the journey, not a direct Appstle cancel (only confirmed fraud bypasses this).
- Loyalty corrections require BOTH the points ledger entry AND the redemption row — never just one.
- Keep the script `_`-prefixed only if it's a throwaway probe; an executed remedy is a real artifact — leave it for the audit trail.

## Related
`src/lib/action-executor.ts` (directActionHandlers) · `docs/brain/recipes/` (issue-refund, create-return, apply-coupon, redeem-loyalty, bill-now) · skills: `probe-db`, `run-orchestrator-action`
