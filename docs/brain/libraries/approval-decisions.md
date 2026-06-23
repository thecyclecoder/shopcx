# libraries/approval-decisions

The tiny best-effort writer behind the [[../tables/approval_decisions]] table — the supervisable-autonomy **audit ledger** (one row per routed-approval decision a director or the CEO makes). See [[../goals/devops-director]] + [[../specs/approval-routing-engine]].

**File:** `src/lib/agents/approval-decisions.ts`

Every decision a director (or the CEO) makes on a routed Approval Request writes ONE row: an autonomous auto-approval, a decline, or an **escalation** UP to the CEO. That ledger is what makes the north-star contract auditable — the CEO can read after the fact **what** the proxy decided and **why** (CEO → Director → tool). The **first concrete writer** is the [[platform-director|Platform/DevOps Director]].

## Exports

- `type DecidedBy = "director" | "ceo" | "human"` · `type ApprovalDecisionKind = "approved" | "declined" | "escalated"` (open vocabulary — the DB has no CHECK).
- `recordApprovalDecision(admin, { workspaceId, agentJobId, pendingActionId?, raisedByFunction, routedToFunction, decidedBy, decision, reasoning, autonomous, metadata? })` → insert one [[../tables/approval_decisions]] row. **Best-effort + never throws** — an audit write that crashed the decision it records would be worse than the gap; no-ops with a warning if the table isn't present yet.

## Related

[[../tables/approval_decisions]] · [[platform-director]] · [[approval-router]] · [[approval-inbox]] · [[director-activity]] · [[../specs/platform-director-agent]] · [[../specs/approval-routing-engine]] · [[../goals/devops-director]]
