-- Software mode for a workspace — per-workspace support mode switch.
--
-- Spec: software-mode-workspace-switch (Phase 1). The ShopGrowth support workspace
-- (f4796217-9dcb-4c7b-b405-6e00f01a2a70) serves Shopify merchants (software), not CPG
-- shoppers. `support_mode` is the single typed switch every ticket-handling step reads:
--   'cpg'      — default; full CPG pipeline (shopper lookup, bucket classifier, journeys/
--                playbooks, fraud gate, order auto-link, Sol first-touch, Appstle/Shopify).
--                Keeps Superfoods behavior unchanged.
--   'software' — straight from resolve to the Sonnet orchestrator; the action executor
--                refuses every CPG action and escalates instead.
--
-- Read by src/lib/support-mode.ts `getSupportMode` / `isSoftwareMode`.

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS support_mode text NOT NULL DEFAULT 'cpg'
  CHECK (support_mode IN ('cpg', 'software'));

-- Idempotent seed: the ShopGrowth merchant-support workspace runs in software mode.
UPDATE public.workspaces
  SET support_mode = 'software'
  WHERE id = 'f4796217-9dcb-4c7b-b405-6e00f01a2a70';
