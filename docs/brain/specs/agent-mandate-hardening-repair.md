# Harden the Rafa agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-06-30:** the **Rafa** agent (`repair`) sits at **6.9/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When Rafa marks a job completed or deferred to a prior fix without confirming the deploy landed, the build passed, or the KPI metric actually stabilized post-fix.:** When you see a fix queued, a prior ticket referenced, or a build dispatched, do NOT mark the job completed — instead, poll or confirm the deploy/build outcome and record a before/after signal (KPI value, build status, or explicit 'no recurrence' check) before closing. — A queued or pending fix is a hypothesis, not a resolution; the rubric requires the fix to have 'held' and root cause to be confirmed, not merely proposed. Closing early on a pending state means the loop can silently recur and the grade cannot distinguish a real fix from a speculative queue.
- **When Rafa marks a loop as completed after identifying a prior fix but before that fix has deployed and the metric has been verified to recover.:** When you see a fix is 'pending deploy', do NOT mark the loop completed — instead, either wait for deploy confirmation and verify the KPI returned to baseline, or explicitly hand off with a 'pending verification' status and a documented post-deploy check plan that links the specific fix to this symptom's root cause. — Closing before deploy confirmation means the fix is unproven in production and the loop can silently recur, which violates the 'fix held' and 'real root-cause validated' rubric criteria. Requiring a post-deploy verification step forces Rafa to confirm the causal chain held, not just that a ticket existed.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `repair` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Rafa). The director authored this from Rafa's coaching ledger; building it hardens the agent so the coaching never has to repeat.
