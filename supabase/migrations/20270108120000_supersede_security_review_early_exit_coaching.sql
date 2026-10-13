-- security-review-lane-must-always-produce-a-verdict Phase 3 — retire the active security-review
-- coaching rows that taught the lane to EARLY-EXIT instead of reviewing.
--
-- RC2 (investigated 2026-10-13): five active public.agent_instructions rows for agent_kind
-- 'security-review' (incl. d59247fc — a specs-row preflight, and 9fc6c0e8 — "fall straight to
-- needs-human") added early exits that turned the lane into "reviews" that reviewed nothing. The lane
-- must ALWAYS produce a real verdict (clean / false-positive / real-vuln); no coaching may short-circuit
-- that. The new guardrail in src/lib/agents/agent-instructions.ts (coachAgent →
-- coachingWouldAddSecurityEarlyExit) prevents re-introducing such coaching; this migration retires the
-- rows that already exist.
--
-- Idempotent: flips every ACTIVE security-review instruction to 'superseded'. Re-running is a no-op
-- (nothing is active to flip). A data UPDATE, not DDL — no table/column is dropped.

update public.agent_instructions
   set status = 'superseded',
       updated_at = now()
 where agent_kind = 'security-review'
   and status = 'active';
