-- Allow null issued_by for system/auto-issued store credit.
-- The automated returns issuer has no workspace_member identity, so a non-uuid
-- sentinel ('system') was being written into a uuid NOT NULL column, failing the
-- ledger insert (303 Postgres errors since 2026-09-26). Null is the correct
-- representation; the FK to workspace_members is retained.
ALTER TABLE public.store_credit_log ALTER COLUMN issued_by DROP NOT NULL;
