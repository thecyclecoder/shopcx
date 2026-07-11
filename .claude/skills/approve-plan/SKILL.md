# approve-plan

**When:** the founder wants to review a **planner's proposed plan** and approve (or decline) it — "Pia finished her plan, look at it and approve them all", "what did the planner propose for goal X", "approve the control-tower plan". A planner (**Pia**, `agent_jobs.kind='plan'`) turns a goal into N proposed specs; this skill renders that proposal in one screen and dispositions **all** of its actions in one command.

**Why:** a plan job stores its proposed specs as `agent_jobs.pending_actions`, and the job only resumes + **materializes the specs once EVERY action has a decision** (`src/lib/roadmap-actions.ts` §"Resume only once every action has a decision"). So a 10-spec plan needs 10 individual `approve <jobId> <actionId>` calls — and worse, the raw actions in `/ceo-approvals` show only titles, so judging the plan means hand-dumping `pending_actions` to see the spec bodies + dependency graph. This skill removes both papercuts: `plan <ref>` renders the full proposal (specs, owners, `⤷ after:` dependency edges, phases) so you can actually judge it; `approve-plan <ref>` / `decline-plan <ref>` decides all pending actions at once and reports whether the job flipped to `queued_resume`.

**Same spine as `/ceo-approvals`.** These are three new subcommands on the SAME `scripts/ceo-approvals.ts` runnable, going through the SAME `approveRoadmapAction` chokepoint (owner-gated, ledger-recorded) the dashboard button and per-action approve use. No new table, no new write path. See [[../ceo-approvals/SKILL]] · [[../../../src/lib/roadmap-actions]] · [[../../../src/lib/agents/approvals-feed]].

## Procedure

1. **Find the plan.** A plan approval shows in `/ceo-approvals list` as a `Planning` card (`goal:<slug>`, `raised=Ada → Henry`). The `<ref>` you pass below is EITHER the goal slug (e.g. `ceo-org-control-tower`) OR the plan `jobId` — `resolvePlanJob` accepts both (UUID → direct; else newest `kind='plan'` job with `spec_slug=<goal>`).

2. **Render + read the plan — don't approve blind.** The founder asked you to *like* it, so actually read it:
   ```sh
   npx tsx scripts/ceo-approvals.ts plan <goal-slug-or-jobId>
   ```
   Each line is one proposed spec: `[status] slug (owner=…)`, its title, `⤷ after: …` (its `blocked_by` dependency edges), summary, and phases. **Judge on:**
   - **Coverage** — do the specs cover every element the goal asked for? (Name the gaps if any.)
   - **Sequencing** — does the `⤷ after:` graph put foundations first (a table/registry before the things that read it, the primitive before its enforcement + UI)? A spec that enforces a switch before the switch table exists is a mis-order.
   - **Owners** — is each `owner` a real function that will *operate* the thing (not just "platform" by default when another department owns it)?
   - **Enforcement, not theater** — for control/guardrail plans especially: is there a spec that actually *enforces* at the execution chokepoint, or only ones that add UI + tables? A switch nobody consults is decoration.

3. **Disposition all actions in one shot.** Once you've judged it (and the founder said go):
   ```sh
   npx tsx scripts/ceo-approvals.ts approve-plan <ref> ["notes"]   # approve EVERY pending action
   npx tsx scripts/ceo-approvals.ts decline-plan <ref> ["notes"]   # decline EVERY pending action
   ```
   It approves each pending action through `approveRoadmapAction`, prints a `✓ / ✗` per spec, then re-reads the job and reports the new status. **`status=queued_resume` = success** — the planner resumes on the next worker tick and materializes the specs (they land `in_review` for Vale, then Ada dispositions to `planned` → the box builds). Any `✗` line means that action failed (surfaced inline) and the job stays pending.

4. **Partial / mixed decisions** still go through the per-action `approve <jobId> <actionId>` / `decline <jobId> <actionId>` commands ([[../ceo-approvals/SKILL]]) — use those when the founder wants to approve some specs and cut others. `approve-plan` is the all-or-nothing fast path.

## Guardrails

- **`plan` is read-only.** It renders the proposal and touches nothing.
- **Don't approve-plan on a bare question.** "What did Pia propose?" = render it (`plan`), not decide it. Approve only on an explicit go-ahead — same rule as [[../ceo-approvals/SKILL]].
- **Read before you approve.** The whole point is that the proposal is now legible — use it. If coverage/sequencing/ownership is off, say so and let the founder decide (decline-plan with notes sends the planner back).
- **Owner-gated + ledgered.** Every decision routes through `approveRoadmapAction` → `assertOwner` + `recordApprovalDecision`, so it's attributed and auditable exactly like the dashboard path. No raw `agent_jobs` writes.
- **`queued_resume` is the win condition.** If the job doesn't reach it, some action is still pending — re-run `plan <ref>` to see which `[pending]` remain.

## Related

- [[../ceo-approvals/SKILL]] — the sibling skill (per-action approve/decline/dismiss + the `list` triage)
- [[../../../src/lib/roadmap-actions]] — `approveRoadmapAction` (the shared chokepoint; the "resume once every action decided" rule)
- [[../../../src/lib/agents/approvals-feed]] — `buildApprovalsFeed` (the `Planning` card in `list`)
- [[../../../docs/brain/project-management]] — Function → (Mandate | Goal→Milestone) → Spec; where a materialized plan's specs go next
- `scripts/ceo-approvals.ts` — the runnable this skill drives (`plan` / `approve-plan` / `decline-plan`)
