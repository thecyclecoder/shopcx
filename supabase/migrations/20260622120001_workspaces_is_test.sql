-- workspaces.is_test — the sentinel marker for the spec-test sandbox (spec-test-deep-verification Phase 2).
-- A workspace flagged is_test=true is a DEDICATED TEST TENANT, isolated from real data: the spec-test
-- agent's sandbox toolkit (scripts/spec-test-sandbox.ts) refuses to fire an event / call an endpoint /
-- write a fixture against any workspace where is_test IS NOT TRUE. All child fixture rows (customers,
-- subscriptions, tickets, migration_audits, …) belong to this workspace via workspace_id, so "scope to
-- the test workspace" reduces to "workspace_id = the is_test workspace id" and the safety assertion
-- ("zero writes to non-test-workspace rows") reduces to "no row with a different workspace_id changed".
-- Idempotent: ADD COLUMN IF NOT EXISTS + a partial index.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- Tiny partial index so "find the test workspace(s)" + the isolation guard are cheap (there is only a
-- handful of test workspaces ever).
CREATE INDEX IF NOT EXISTS idx_workspaces_is_test ON public.workspaces (id) WHERE is_test = true;

COMMENT ON COLUMN public.workspaces.is_test IS
  'Sentinel: true = dedicated spec-test sandbox tenant (spec-test-deep-verification Phase 2). The sandbox toolkit only ever operates on is_test=true workspaces; real tenants are is_test=false.';
