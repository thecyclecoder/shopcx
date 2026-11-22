-- Next-order journey definition: the in-journey subscription editor surface.
-- slug 'next-order', trigger_intent 'next_order', channels email + sms.
-- journey_type 'custom' (the journey_type CHECK does not carry a dedicated
-- next-order type; routing is by trigger_intent, same as the crisis journeys).
-- Seeded for every workspace, idempotent via the slug uniqueness guard so a
-- re-run is a no-op (CLAUDE.md: idempotent SQL migration rail).

INSERT INTO public.journey_definitions
  (workspace_id, slug, name, journey_type, trigger_intent, description, config, channels, is_active, priority)
SELECT
  ws.id,
  'next-order',
  'Next Order',
  'custom',
  'next_order',
  'In-journey subscription editor: swap, quantity, add, remove, skip, change date, change frequency, and cancel through the same save offers.',
  '{}'::jsonb,
  ARRAY['email', 'sms'],
  true,
  5
FROM public.workspaces ws
WHERE NOT EXISTS (
  SELECT 1 FROM public.journey_definitions jd
  WHERE jd.workspace_id = ws.id
    AND jd.slug = 'next-order'
);
