-- June (CS Director) refund-approval threshold.
-- A refund/credit remedy whose amount is STRICTLY ABOVE this many cents routes to a founder SMS
-- approval (via Eve's cockpit) before June executes it; at-or-below runs autonomously. Default $50.
-- Read by src/lib/june-remedy-approval.ts getRefundApprovalThresholdCents. Additive + idempotent.
alter table public.workspaces
  add column if not exists june_refund_approval_threshold_cents integer not null default 5000;
