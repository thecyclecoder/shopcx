-- Win-back free-bag offer becomes a limited-time, while-supplies-last promo (CEO 2026-11-21: "we can't offer this free gift forever").
-- The email says the free bag ends Monday Nov 30; loadWinbackGifts (src/lib/reactivate-journey-builder.ts)
-- stops offering gifts once config.winback_gifts_ends_at has passed, so the deadline is real.
-- 2026-12-01T07:59:59Z = Nov 30 11:59:59 PM Pacific. Idempotent: re-running sets the same key.
UPDATE journey_definitions jd
SET config = COALESCE(jd.config, '{}'::jsonb) || jsonb_build_object('winback_gifts_ends_at', '2026-12-01T07:59:59Z'),
    updated_at = now()
WHERE jd.slug = 'reactivate-subscription'
  AND jd.workspace_id = (SELECT pv.workspace_id FROM product_variants pv WHERE pv.id = 'e3953a24-c060-41e7-9ca4-06a481df236b');
