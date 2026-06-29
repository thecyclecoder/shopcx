# libraries/director-activity

The tiny best-effort writer behind the [[../tables/director_activity]] table — the timestamped action log every director (and every worker a director supervises) writes a row to on each action it takes ([[../goals/devops-director]]).

**File:** `src/lib/director-activity.ts`

That single log is the substrate for **(1)** the autonomous-approval **audit history**, **(2)** the gamified [[director-board|#directors board]] posts, and **(3)** the **EOD recap** (a read over *today's* rows — never hand-maintained). The **first concrete writer** is the [[regression-agent|Regression Agent]]: every detect / dismiss / author / escalate action it takes writes one row here.

## Exports

- `type DirectorActionKind = "detected_regression" | "dismissed_regression" | "authored_fix" | "escalated"` — the action kinds the Regression Agent emits (open vocabulary — the live directors add more, e.g. `approved_migration`, `fixed_bug`, `escorted_goal`).
- `recordDirectorActivity(admin, { workspaceId, directorFunction, actionKind, specSlug?, reason, metadata? })` → insert one [[../tables/director_activity]] row. `directorFunction` = the function whose objective owns the action; a **worker** action carries its **supervising director's** function (the worker answers to the director — CEO → director → worker). **Best-effort + never throws** — an audit write that crashes the action it records is worse than the gap; no-ops with a warning if the table isn't present yet.
- `spec_deferred_programmatic` — the **no-silent-spec-defer** audit kind ([[../operational-rules]] § No silent spec defers). Every PROGRAMMATIC (non-human) flip of a spec to `deferred` writes one of these via [[spec-defer-audit]] `auditedProgrammaticDefer` — `actor` = who parked it, `reason` = a CONCRETE why (for a loop/repair defer: which loop/signature + resolved/superseded/pending-deploy), `metadata` may carry `repair_signatures`. The same helper also emits a CEO "Spec deferred — <why>" notification. The CEO's own dashboard Defer (`owner:{user.id}`) is exempt (already provenanced via `spec_status_history`).
- `clearDirectorSpecDismissals(admin, workspaceId, slug, reason)` → `{ cleared }` — the **re-author-re-opens-dismissed** ledger-hygiene writer ([[author-spec]] `reopenIfReauthoredAndChanged`). DELETES a spec's standing `init_dismissed` / `groomed_dismissed` rows (the dedup rows whose `metadata.init_key`/`groom_key` the [[platform-director]] `alreadyInitiated`/`alreadyGroomed` readers scan to SKIP a spec forever) and writes ONE `spec_reopened_after_reauthor` audit row naming the superseded keys. Scope is ONLY the `*_dismissed` dedup rows — `escalated` / `*_authored_spec` rows are left intact (audit value > dedup cost). `director_activity` is NOT a PM table, so this delete is OUTSIDE the PM-SDK guard. **Best-effort + never throws.**

## Related

[[../tables/director_activity]] · [[regression-agent]] · [[../goals/devops-director]] · [[../specs/director-loop-grading]] · [[director-board]]
