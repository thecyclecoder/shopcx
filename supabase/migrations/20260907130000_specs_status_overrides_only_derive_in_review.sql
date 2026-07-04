-- specs.status is OVERRIDE-ONLY and `in_review` is now DERIVED, never stored.
--
-- THE DRIFT PROBLEM (roadmap):
--   `deriveSpecCardStatus` short-circuited on a STORED `specs.status = 'in_review'` BEFORE rolling up the
--   phases — so a spec whose phases all shipped, but whose `in_review` override was never cleared, was
--   pinned in the "In Review" column forever. A stored status can always drift out of sync with the phase
--   reality; that is the whole risk of storing a derived value.
--
-- THE FIX: the only lifecycle facts that CANNOT be derived from the phases stay on the column —
--   - deferred  — the CEO parked it (also mirrored on `specs.deferred`).
--   - folded    — archived after a fold.
--   - NULL      — no override → status is PURELY the phase rollup (`deriveSpecCardStatus`).
-- `in_review` is REMOVED from the column. It is now DERIVED at read time: a spec reads `in_review` iff no
--   build has started (the phase rollup is still `planned`) AND Vale has not durably passed it
--   (`vale_review_passed_at IS NULL`). `vale_review_passed_at` is the SAME durable signal the claim-time
--   build gate already reads (`specReviewDone` / `valeReviewPassed`), so the board and the build gate can
--   never disagree, and — because `in_review` can only appear while the rollup is `planned` — a built spec
--   can NEVER read `in_review`. The stored-override drift class is gone by construction.
--   • send-back ("this spec changed, re-review it") is expressed by NULLing `vale_review_passed_at`
--     (`markSpecCardBackToReview` already does this) — no stored status needed.
--
-- Companion app changes (same PR): brain-roadmap.ts `deriveSpecCardStatus` derives in_review from the
-- rollup + `vale_review_passed_at`; the override chokepoints (`isOverrideStatus`, `upsertSpec`,
-- `setSpecStatus`) drop `in_review` so every writer auto-maps an `in_review` write to NULL; Vale's queue
-- (`spec-review.ts`) and Ada's disposition sweep (`spec-dispose.ts`) select their work by the `vale_pass` /
-- `vale_review_passed_at` signals instead of `status='in_review'`; the platform wake probe reads
-- `status IS NULL` for "non-terminal spec".

-- 1. Retire every stored `in_review` override to NULL. These specs re-derive their true board status from
--    the phase rollup + `vale_review_passed_at` (a fresh, un-passed spec still reads `in_review`; a passed
--    or built one reads planned/shipped). Idempotent.
update public.specs set status = null, updated_at = now() where status = 'in_review';

-- 2. A newly-inserted spec starts with no override (NULL) — a fresh row has `vale_review_passed_at IS NULL`
--    and no phases, so it DERIVES `in_review` without the column needing to carry it.
alter table public.specs alter column status set default null;

-- 3. Tighten the CHECK: the column may hold ONLY the two non-derivable lifecycle overrides, or NULL.
--    `planned` / `in_progress` / `shipped` (derived rollup values) and `in_review` (now derived) are all
--    REJECTED — a write attempting any of them is the drift bug we are eliminating.
alter table public.specs drop constraint if exists specs_status_check;
alter table public.specs add constraint specs_status_check check (
  status is null or status in ('deferred','folded')
);
