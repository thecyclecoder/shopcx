# media-buyer-insights (`src/lib/media-buyer/insights.ts`)

The M3 measurement-lane SDK for [[../functions/growth]] — reads the split column shipped in
[[../tables/media_buyer_action_grades]] (`dahlia_copy_mode`) + [[../tables/meta_insights_daily]]
(`inline_link_clicks`) and returns the per-copy-mode CAC + inline-link-CTR delta the flag-graduation
gate for DAHLIA_COPY_MODE reads directly ([[../specs/dahlia-cold-graded-inline-link-ctr-leading-signal]]).

Sibling of [[media-buyer-grader]] — grader WRITES the per-mode split at grade time; this SDK READS
it aggregated over a trailing window.

## Exports

- `PER_COPY_MODE_MIN_N = 20` — the sample-size guard both buckets must clear before the helper is
  trusted. Below that, `insufficient_data:true` is returned so a caller can't false-graduate on noise.
- `PER_COPY_MODE_GRADEABLE_KINDS = ['media_buyer_promoted_winner', 'media_buyer_paused_loser']` — the
  M3 gate's own action-kind whitelist. Restricts the read to promote/kill so replenish rows don't
  drown out the comparative signal.
- `type PerCopyModeBucket = { n, attributed_spend_cents, orders, cac_cents, impressions, inline_link_clicks, inline_link_ctr }`.
- `type PerCopyModeCtrCac = { author, deterministic, delta: {cac_cents, inline_link_ctr}, window, insufficient_data }`.
- `aggregatePerCopyMode(grades, attribution, insights, window) → PerCopyModeCtrCac` — the pure
  aggregator (no DB). Exposed for unit tests to hit without Supabase.
- `getPerCopyModeCtrCac(admin, workspaceId, {days=14, audienceCohort='cold', nowMs?}) → Promise<PerCopyModeCtrCac>` —
  the runtime chokepoint. Reads [[../tables/media_buyer_action_grades]] over the trailing window,
  joins to [[../tables/meta_attribution_daily]] (CAC) + [[../tables/meta_insights_daily]] `level='ad'`
  (inline-link-CTR), and returns the two buckets + delta + insufficient_data flag.

## NULL semantics (M3 measurement-lane invariants)

- A grade row with `dahlia_copy_mode = null` is DROPPED before bucketing. Treating it as either
  mode would poison the delta (pre-migration state or an off-platform ad). Backfilled by
  `scripts/_backfill-media-buyer-grades-dahlia-copy-mode.ts` (auto-ledgered via
  [[ship-time-backfill-detector]]).
- An insights row with `inline_link_clicks = null` is DROPPED from BOTH the CTR numerator and
  denominator — its impressions are NOT counted. Meta didn't report link clicks for that day and
  treating unknown as 0 is exactly the false-success the M3 spec calls out. Pinned by the unit
  test `src/lib/media-buyer/insights.per-copy-mode.test.ts` case (c).
- CAC is null when `orders=0` (unknown, not ∞). Delta is null when either side is null.

## Callers

- [[media-buyer-director-digest]] surfaces the per-mode delta on every Bianca pass so
  #director-growth-max sees the M3 signal alongside the promote/kill grade averages.
- The DAHLIA_COPY_MODE flag-graduation gate recommends flipping the default from `deterministic`
  to `author` only when `insufficient_data:false` AND both `delta.cac_cents < 0` AND
  `delta.inline_link_ctr > 0` — never on noise.

## Test seams

- `npm run test:insights-per-copy-mode` — pins (a) split correctness, (a1) null-mode grade
  exclusion, (b/b1) insufficient_data trigger, (c/c1) null-inline-link-clicks exclusion from CTR,
  and CAC-null-when-orders-zero. Unit tests hit `aggregatePerCopyMode` directly; the runtime
  DB path in `getPerCopyModeCtrCac` is thin composition over it.

---

[[../README]] · [[../../CLAUDE]] · [[media-buyer-grader]] · [[media-buyer-director-digest]] · [[../tables/media_buyer_action_grades]] · [[../tables/meta_insights_daily]] · [[../tables/meta_attribution_daily]] · [[../specs/dahlia-cold-graded-inline-link-ctr-leading-signal]]
