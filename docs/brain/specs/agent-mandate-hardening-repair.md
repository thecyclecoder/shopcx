# Harden the Rafa agent — roll persistent coaching into its mandate

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — graduate persistent coaching into a durable fix (director grades agents: low score → fix spec, never a CEO escalation)
**Found in use 2026-06-30:** the **Rafa** agent (`repair`) sits at **6.8/10** after **2** coaching attempts that didn't stick. Rather than escalate to the CEO, roll the coaching into a permanent fix so the agent improves at the mandate level.

## The accumulated coaching to bake in (now archived as rolled-into-mandates)
- **When Rafa consistently marks loops as completed when a fix exists but is still 'pending deploy', closing out before the resolution is confirmed to have held in production.:** When you see a referenced fix that is 'pending deploy', do NOT mark the loop completed — instead mark it 'pending verification', briefly document the root-cause linkage between the prior fix and this specific symptom, and either wait for deploy confirmation or explicitly hand off a post-deploy validation step (e.g. confirm KPI returns to baseline) before closing. — A fix that hasn't landed in production cannot be confirmed as 'held', so closing early violates the rubric's 'fix held / error didn't recur' criterion. Documenting the root-cause linkage and a verification gate ensures the repair is genuinely complete rather than deferred, which is what separates a 6 from a 10.
- **When Rafa consistently closes loops as 'completed' after identifying a prior fix exists, without waiting for or verifying that the fix has actually deployed and the metric has recovered.:** When you see a fix referenced as 'pending deploy', do NOT mark the loop completed — instead, either wait for deploy confirmation and validate the KPI returned to baseline before closing, or explicitly set status to 'pending verification' with a documented handoff/watch step tied to the deploy landing. — A fix that hasn't deployed hasn't held — the rubric requires the error didn't recur, which cannot be confirmed until production reflects the change and the metric recovers. Closing prematurely on an undeployed fix conflates 'cause identified' with 'repair confirmed', which is the core reason every grade stalled at 6/10.

## Phase 1 — bake the coaching into the agent
- Make the above coaching PERMANENT behavior of the `repair` agent — fold it into its prompt/mandate/code (its run-job + prompt in `scripts/builder-worker.ts` and the relevant `src/lib/agents/*`), not ephemeral appended `agent_instructions`. Once baked, the agent should follow it by default.
- Verify the agent's grade rollup recovers (≥ 7/10) over the next window of graded actions; if a coaching class still recurs, the bake-in missed it.

## Ownership
Owner: [[../functions/platform]] (Ada supervises Rafa). The director authored this from Rafa's coaching ledger; building it hardens the agent so the coaching never has to repeat.
