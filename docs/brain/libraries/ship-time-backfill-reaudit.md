# libraries/ship-time-backfill-reaudit

The Phase-2 repair for [[../specs/ship-time-backfill-executor-passes-apply]]. Phase 1 fixed the [[ship-time-backfill-executor]] to spawn with `--apply`, but it did nothing about the ~14 [[../tables/data_op_runs]] rows **already** marked `ran` by the OLD executor — those APPLY-gated scripts only dry-ran, so some never wrote. They are idempotent, so a fresh DRY-RUN re-check is safe.

**Files:** `src/lib/ship-time-backfill-reaudit.ts` (pure classifiers) + `scripts/_backfill-reaudit-dry-run-ledger-rows.ts` (the one-time I/O shell, itself ledgered + drained via the normal rail).

## The judgment — one dry run, three verdicts

`scripts/_backfill-reaudit-dry-run-ledger-rows.ts` reads every `status='ran'` row (skipping itself), validates the `script_path` as an untrusted capability boundary ([[ship-time-backfill-executor]] `isValidScriptPathForExec`), and:

- **script gone from main / invalid path** → escalate (can't re-check).
- **no `--apply` gate** (`scriptHasApplyGate` false) → the script always writes, so it DID write on its first run → left `ran`, untouched.
- **APPLY-gated** → spawn `npx tsx -- <script>` in DRY-RUN (with `APPLY` **stripped** from the child env — the box runs the reaudit itself with `APPLY=1`, which the child would otherwise inherit and WRITE), then `classifyReauditDryRun(stdout)`:
  - `pending` — a positive would-write COUNT ⇒ never wrote ⇒ `markLedgerRowPendingForReaudit` resets the row `ran → pending`; the Phase-1 `executeShipTimeBackfillsForSpec` then re-drains it WITH `--apply`.
  - `noop` — an explicit no-op signal (and no positive count) ⇒ already applied ⇒ left `ran`.
  - `ambiguous` — prose with no clean count or no-op (a surgical one-customer fix like "would insert Brittany's coupon"), or a dry run that errored ⇒ NOT auto-re-run (re-applying a one-off refund could double-charge) ⇒ escalate.

Every row we refuse to auto-re-run is listed on ONE CEO approvals card per workspace via [[agents/platform-director|`escalateDiagnosisToCeo`]] with `dedupeKey: "backfill-reaudit"` — the founder decides.

## Exports (`ship-time-backfill-reaudit.ts`)

- `REAUDIT_DEDUPE_KEY = "backfill-reaudit"` · `REAUDIT_ESCALATION_KIND = "ship_time_backfill_reaudit"` — the CEO-card dedupe key + `metadata.escalation_kind`.
- `scriptHasApplyGate(source)` — pure: true iff the script's source reads `--apply` on argv or `process.env.APPLY` (i.e. is dry-run-by-default).
- `classifyReauditDryRun(stdout): "noop" | "pending" | "ambiguous"` — pure. Checks a positive structured count (`would-write=3`, `would update 5`, `would insert 2`) FIRST so a `no-op=2 would-write=3` summary reads as pending, not a no-op; then the explicit no-op signals (`no-op`, `nothing to do`, `0 rows`, `would update 0`, `would-write=0`, `scanned=0`); else ambiguous.

## Guardrails / invariants

- **Idempotent + safe to re-run.** A second pass sees already-reset rows as `pending` (skipped by the `status='ran'` scan) and already-applied rows reporting no-op.
- **NEVER auto-re-runs an ambiguous / surgical one-off.** Those escalate so a human calls it — the premise "re-checking is safe" holds only for the idempotent batch scripts the dry run clearly classifies.
- **Dry-run children never inherit `APPLY=1`.** The reaudit explicitly `delete childEnv.APPLY` before spawning, so the re-check can't accidentally write.
- **Compare-and-set writes.** `markLedgerRowPendingForReaudit` guards on `status='ran'` + workspace + `.select('id')` so a concurrent pass can't clobber a row's state.
- **Capability boundary before spawn.** `script_path` is validated by `isValidScriptPathForExec` and spawned as array argv with a `--` separator — never a shell string.

## Related

[[ship-time-backfill-executor]] (the Phase-1 drain this reuses) · [[ship-time-backfill-detector]] (`markLedgerRowPendingForReaudit` lives there — the ledger module) · [[../tables/data_op_runs]] (the ledger it re-audits) · [[agents/platform-director]] (`escalateDiagnosisToCeo` — the CEO-card surface) · [[../specs/ship-time-backfill-executor-passes-apply]]
