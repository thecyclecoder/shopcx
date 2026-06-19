---
name: audit-reconcile
description: Use to find and (optionally) fix drift between two sources of truth in ShopCX — our DB vs an external system (Shopify/Appstle/Stripe), or a derived column vs its source. The genre of the 9 scripts/audit-*.ts / reconcile-*.ts. Produces a dry-run manifest of discrepancies first; only fixes them with --apply. Triggered by "audit {X} against {Y}" or "reconcile {derived} with {source}."
---

# audit-reconcile

Detect drift, report it, then close it deliberately. An **audit** answers "where do these two sources disagree?" — a **reconcile** is an audit that can also fix the gap. Always surface the full discrepancy manifest *before* mutating anything; the fix is opt-in.

## Procedure

1. **Create** `scripts/audit-{topic}.ts` (read-only finding) or `scripts/reconcile-{topic}.ts` (find + fix). Standard bootstrap + `createAdminClient()` (see [[script-conventions]]).
2. **Define the two sides + the match key.** What's the source of truth, what's the mirror, and what UUID/business key joins a pair? (e.g. our `returns` rows vs Shopify returns by `shopify_return_gid`; a derived `customer_id` vs its resolved source.)
3. **Build the discrepancy manifest (dry-run, always first).** Walk both sides (cursor-paginated, see [[backfill]]) and bucket every mismatch — `missing_in_db`, `missing_in_source`, `value_drift`, `orphaned`. Print a per-bucket count + a sample of rows with the exact differing fields. **This runs with no flag and never mutates.**
4. **Gate the fix behind `--apply`.** Only `reconcile-*` scripts fix, and only when `--apply` is passed. Each fix is itself idempotent (re-checks state before writing) so a partial re-run is safe. Print every fix as `key: before → after`.
5. **Resumable.** Re-running re-derives the manifest from live state, so a crash mid-fix just re-discovers the still-broken rows on the next pass — no checkpoint file needed.
6. **Final tally** — `pairs checked | in sync | drifted (by bucket) | fixed | errors`. The manifest is the artifact; keep it readable.
7. **Run:** `npx tsx scripts/audit-{topic}.ts` (read the manifest) → for a reconcile, `npx tsx scripts/reconcile-{topic}.ts --apply`.

## Guardrails

- **Dry-run is the default and the whole point.** Never auto-fix on first run; a human reads the manifest and decides. An `audit-*` script (no `--apply` path at all) is the safe choice when you only need to *know*.
- **Decide the source of truth explicitly.** "Drift" is meaningless without knowing which side wins. Fixing the wrong side corrupts the good data — state the direction in the script header.
- **Idempotent fixes** — re-check each row's state immediately before writing; never blind-`UPDATE`. Money-affecting reconciles (refunds, credits, charges) get extra care: never re-issue, double-credit, or double-charge.
- **Never run during active Inngest syncs** (the mirror is mid-write — you'd "find" transient drift and fix phantoms). Internal joins use UUIDs, not `shopify_*_id`; writes go through `createAdminClient()`.
- An executed reconcile is a real artifact — leave it for the audit trail (not `_`-prefixed).
- **No prod creds under the box worker.** Author the script; request approval to run an `--apply` reconcile via `{"status":"needs_approval","actions":[{"type":"run_prod_script","summary":"…","cmd":"npx tsx scripts/reconcile-{topic}.ts --apply"}]}` and stop. A read-only `audit-*` dry run needs no gate locally, but on the box it still needs creds → request it the same way.

## Related
`scripts/audit-return-refund-prompts.ts` · `scripts/reconcile-shopify-theme.ts` · skills: `script-conventions`, `probe-db`, `backfill`, `customer-remedy` · `docs/brain/operational-rules.md`
