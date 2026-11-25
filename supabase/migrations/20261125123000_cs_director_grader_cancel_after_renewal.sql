-- CS Director grader — pin the cancel-after-renewal calibration clause
-- (spec cancel-after-renewal, Phase 2). A refund request on a renewal that charged
-- BEFORE the customer cancelled is a standard Refund-playbook case and is NEVER an
-- escalate_founder — a customer's MENTION of a bank dispute is not a chargeback unless
-- public.chargeback_events has a row for the order. Ground truth: ticket b44584dc
-- (Brooke Miedema) cancelled 2h20m after a renewal charged, cited a bank dispute with
-- no chargeback_events row, and June escalated the 'chargeback' to the founder.
--
-- Mirrors 20260919120000_cs_director_grader_anti_goodhart_clause.sql: a
-- director_grader_prompts calibration row (status='approved', sort_order=11 so it lands
-- right after the anti-Goodhart clause in the CALIBRATION RULES block of
-- buildDirectorGraderSystemPrompt, which orders by sort_order ASC). This IS the CEO's
-- own correction to the CS-Director rubric: penalize escalate_founder on cancel-after-
-- renewal. Idempotent via NOT EXISTS keyed on (workspace_id, title); never destructive —
-- an existing row keeps whatever disposition the CEO has since given it. One row per
-- workspace by iterating public.workspaces.
--
-- Applies via: npx tsx scripts/apply-cs-director-grader-cancel-after-renewal.ts

insert into public.director_grader_prompts (workspace_id, title, content, status, sort_order)
select w.id,
       'CS Director cancel-after-renewal — never escalate_founder',
       'Cancel-after-renewal is never escalate_founder. A refund request on a renewal that charged before the customer cancelled is a standard Refund-playbook case: the right verdict is approve_remedy back into the ladder, not a founder page. A customer''s mention of a bank dispute or chargeback is NOT a chargeback unless chargeback_events has a row for the order; even then June routes it to the chargeback pipeline, not the founder. PENALIZE an escalate_founder verdict on a cancel-after-renewal refund.',
       'approved',
       11
  from public.workspaces w
 where not exists (
   select 1 from public.director_grader_prompts p
    where p.workspace_id = w.id
      and p.title = 'CS Director cancel-after-renewal — never escalate_founder'
 );
