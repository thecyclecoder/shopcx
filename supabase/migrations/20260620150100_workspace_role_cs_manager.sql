-- box-ticket-improve P4: add a `cs_manager` workspace role so the CX manager can drive the ticket
-- Improve agent (propose + approve customer fixes) and own ticket-derived code specs (functions/cs).
-- ALTER TYPE ... ADD VALUE is idempotent via IF NOT EXISTS and runs outside a transaction block.
-- See docs/brain/tables/workspace_members.md + docs/brain/functions/cs.md.

alter type public.workspace_role add value if not exists 'cs_manager';
