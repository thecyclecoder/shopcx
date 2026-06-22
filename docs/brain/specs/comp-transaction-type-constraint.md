# Comp Transaction Type Constraint Fix ⏳

**Owner:** [[../functions/platform]] · **Parent:** Retention mandate "Subscription continuity & billing integrity" ([[../lifecycles/subscription-billing.md]]) — fixes the shipped [[comp-subscriptions]] spec.

The shipped [[comp-subscriptions]] build writes ledger rows with `type='comp'`, but `transactions.type` is a `TEXT` column guarded by an inline `CHECK (type IN ('initial_checkout','renewal','dunning_retry','manual'))` (`supabase/migrations/20260520160000_transactions.sql:41`, auto-named `transactions_type_check`). The comp migration `20260620190000_comp_subscriptions.sql` never extended that constraint, so **every** comp ledger insert violates it — and because neither insert in `internal-subscription-renewals.ts` checks the returned error, the violation is silently swallowed. The result: the fail-closed branch's `needs_attention` failed-comp row never lands (caught by spec-test QA), and the success branch's `type='comp' status='succeeded'` row has the identical latent failure (undetected, because the success path is destructive and was never run live). Both ledger writes are currently dropped on the floor. This breaks billing-integrity auditability: a comp sub that wrongly failed the allowlist gate, or a comp renewal that shipped free, leaves no transaction record. The fix extends the constraint to admit `'comp'` and makes both inserts fail loud.

## Phase 1 — extend the constraint + surface insert errors ⏳
- ⏳ New migration `supabase/migrations/<ts>_comp_transaction_type.sql`: `ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;` then `ADD CONSTRAINT transactions_type_check CHECK (type IN ('initial_checkout','renewal','dunning_retry','manual','comp'));`. It's `TEXT`+`CHECK`, not a pg enum — a clean one-shot constraint swap, no `ALTER TYPE`.
- ⏳ Apply script `scripts/apply-comp-transaction-type-migration.ts` (follows [[../recipes/applying-migrations]] / `script-conventions`; runs the migration against the Supabase pooler).
- ⏳ Add `if (error) throw new Error(...)` to **both** `transactions` inserts in `src/lib/inngest/internal-subscription-renewals.ts` — the fail-closed `comp-gate-failed-transaction` step (~:156) and the success `comp-transaction` step (~:239). A swallowed insert error silently defeats the fail-closed "surface it" contract; after this a DB write failure errors the step (retries/visible) instead of vanishing.
- ⏳ `npx tsc --noEmit` gate.

## Phase 2 — brain ⏳
- ⏳ `docs/brain/tables/transactions.md`: list `comp` in the `type` allowed set (and the `type` gotcha note).
- ⏳ Fold note into [[comp-subscriptions]] (Verification block) recording the constraint fix; cross-link [[../lifecycles/subscription-billing.md]].

## Safety / invariants
- **Fail-closed must surface.** The whole point of the comp allowlist gate is that a non-allowlisted comp sub does NOT ship and **leaves a `needs_attention` ledger row + event**. A swallowed insert error breaks that silently — both comp inserts must fail loud.
- **Constraint widens, never narrows.** Adding `'comp'` to the `IN (...)` set cannot reject any row that previously passed; existing `initial_checkout`/`renewal`/`dunning_retry`/`manual` rows are unaffected. Drop-then-add runs in one migration transaction.
- **No behavior change to the renewal flow itself.** This fix only lets the already-written ledger rows land and makes failures loud — it does not alter the order/Amplifier/advance/dunning logic.
- **No new `type` values introduced beyond `'comp'`** — the two call sites (`:156`, `:239`) are the only `type:'comp'` inserts in the tree (verified by grep).

## Completion criteria
- The constraint admits `'comp'`; both comp inserts land their rows in prod.
- Both comp `transactions` inserts have an `if (error) throw` so a future schema/constraint break is loud, not swallowed.
- `tables/transactions.md` reflects the `comp` type; [[comp-subscriptions]] carries a fold note.
- `npx tsc --noEmit` clean. Re-verification (below) passes — the spec-test QA failing check now reports `failed_comp_transaction=TRUE`.

## Verification
Strictly non-destructive (no order, no Amplifier, no `next_billing_date` advance, no live Zach renewal). "ws" = `fdc11e10-b89f-4989-8b73-ed6526c4d906`.

- **Constraint extended** → read-only probe: `select pg_get_constraintdef(oid) from pg_constraint where conname='transactions_type_check'` → the `CHECK` definition includes `'comp'` alongside the original four values.
- **Both ledger writes land (local harness)** → a non-destructive harness inserts, into an `is_test` workspace, two `transactions` rows mirroring the renewal branches: (1) `type='comp' status='failed' amount_cents=0 metadata.needs_attention=true` (fail-closed), and (2) `type='comp' status='succeeded' amount_cents=0` (success). Assert both inserts return **no error** and the rows are readable back — proving the writes the silent-swallow was eating now succeed. Clean up the test rows (or rely on `is_test` isolation).
- **Surfacing fires loud** → the harness attempts an insert with a deliberately invalid `type` (e.g. `'bogus'`) and asserts the insert returns an error — confirming the new `if (error) throw` in the renewal path would surface a real constraint break instead of swallowing it.
- **Spec-test QA re-run (fail-closed)** → re-run the `comp-renewal-failclosed` non-destructive flow on `is_test` fixtures (the check that previously reported `failed_comp_transaction=FALSE`): now expect `failed_comp_transaction=TRUE` — the `type='comp' status='failed'` (`metadata.needs_attention=true`) row lands — alongside the already-passing `subscription.comp_renewal_failed` event, `no_order_created`, and `billing_date_not_advanced` assertions, with `isolation.zero_non_test_workspace_writes=true` preserved.
- **No regression** → `select count(*) from transactions where type in ('initial_checkout','renewal','dunning_retry','manual')` returns the same pre-migration count (constraint widened, not narrowed).
- **Type-check** → `npx tsc --noEmit` is clean.
