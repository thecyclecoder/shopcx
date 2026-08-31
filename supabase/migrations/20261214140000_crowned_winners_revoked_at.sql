-- Revocation is not exhaustion — give it its own field.
--
-- CEO 2026-08-28. Two DIFFERENT facts were being carried by one flag:
--
--   exploit_exhausted = true  →  "cloning this winner stopped producing hits" (4 strikes, 0 hits).
--                                The winner itself may STILL deserve to graduate to the scaler.
--   revoked_at        = <ts>  →  "this crown no longer qualifies under the current policy".
--                                It is a retired record, not pending work.
--
-- On 2026-08-25 all five crowns were revoked (crown_min_purchases 8→15 plus the confidence bound
-- meant none of them qualified any more) using `markExploitExhausted`, because that was the only
-- SDK that existed. Conflating the two meanings had an immediate consequence: the cold-scaler
-- graduate-stall heartbeat counts "eligible" winners as `graduated_at IS NULL` with no notion of
-- revocation, so it raised CEO cards claiming Superfood Tabs had "3 crowned winners but no
-- graduate" and Zen Relax "2" — every one of them a crown that had been retired three days earlier.
-- Genuine pending work in both cohorts: ZERO.
--
-- Same failure shape as `readCurrentLiveCrownedCount` before it learned to filter: two readers over
-- one table disagreeing about what still counts as a winner.
alter table public.media_buyer_crowned_winners
  add column if not exists revoked_at timestamptz;

alter table public.media_buyer_crowned_winners
  add column if not exists revoked_reason text;

comment on column public.media_buyer_crowned_winners.revoked_at is
  'When this crown was RETIRED because it no longer qualifies under the active iteration policy. Distinct from exploit_exhausted (which means cloning it stopped producing hits — that winner may still deserve to graduate). A revoked crown is NOT pending graduate work: countEligibleCrownedWinnersByCohort excludes it, so the stall heartbeat cannot raise a CEO card for retired records. NULL = still a live crown.';

comment on column public.media_buyer_crowned_winners.revoked_reason is
  'Plain-language why the crown was retired (e.g. "crown_min_purchases raised 8->15 + confidence bound; no longer qualifies").';

-- Backfill the 2026-08-25 revocations: every crown marked exhausted on that date was revoked by the
-- policy change, not by the strike counter (exploit_spawned never reached EXPLOIT_EXHAUST_STRIKES=4
-- for any of them). Idempotent — only fills rows still missing revoked_at.
update public.media_buyer_crowned_winners
set
  revoked_at = coalesce(revoked_at, exploit_exhausted_at),
  revoked_reason = coalesce(
    revoked_reason,
    'CEO 2026-08-25: crown_min_purchases raised 8->15 and crowning moved to the confidence-bounded CPA; this crown no longer qualifies under the active policy.'
  )
where exploit_exhausted = true
  and revoked_at is null
  and exploit_exhausted_at::date = date '2026-08-25'
  and coalesce(exploit_spawned, 0) < 4;
