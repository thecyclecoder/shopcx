# libraries/director-xp

The **derived, display-only XP** layer behind the gamified [[director-board|#directors board]] ([[../specs/directors-board-gamified]], M3 Phase 3 of [[../goals/devops-director]]). Computes four "gamification" counts per director (function slug) — **specs shipped · bugs fixed · goals escorted · streak** — entirely from existing truth, no new event capture.

**File:** `src/lib/agents/director-xp.ts` (server-only — `createAdminClient` + [[brain-roadmap]] fs reads) · the card lives in `src/components/agents/xp-card.tsx`.

**North-star invariant** ([[../operational-rules]] § supervisable autonomy): XP is **a gamified proxy, never an objective the directors optimize** — it is read-only and **display-only**, never written back, never a target. It reconciles against the source tables on inspection; it is not gospel.

## Exports

- **`interface DirectorXp { specsShipped; bugsFixed; goalsEscorted; streak }`** — the four counts for one director. The client mirror is re-declared in `xp-card.tsx` (`"use client"`, no server import).
- **`type DirectorXpMap = Record<string, DirectorXp>`** — keyed by function slug.
- **`getDirectorXp(workspaceId): Promise<DirectorXpMap>`** — one pass that seeds a zeroed entry for every `functions/*.md` slug and fills the four counts (below). Only ever attributes to a real director (a stray `director_function` / `raised_by_function` that isn't a function is ignored).

## How each count is derived

| Count | Source | Rule |
|---|---|---|
| `specsShipped` | [[../tables/agent_jobs]] | `kind='build'` + `status='merged'` rows whose `spec_slug` maps to the function in the **live spec→owner map** ([[brain-roadmap]] `getRoadmap().specs[].owner`). A folded spec leaves `specs/`, so this is a display proxy, not a lifetime ledger. |
| `bugsFixed` | [[../tables/approval_decisions]] × [[../tables/agent_jobs]] | `decision='approved'` decisions whose raising `agent_job_id` is `kind ∈ {repair, regression}`, counted by `raised_by_function` — the repair/error-fix approvals the director handled (pre-M4 owner-approved, post-M4 a live director's auto-approval — both `decision='approved'`). |
| `goalsEscorted` | [[brain-roadmap]] | shipped milestones (`status='shipped'` or `completion≥1`) across the goals the function owns/contributes to (`getFunctions()[].goalSlugs` × `getGoals()[].milestones`). Milestones advanced = M4's job. |
| `streak` | [[../tables/director_activity]] | consecutive active **UTC** days (rows for `director_function`) ending today; anchors on today OR yesterday so an as-yet-quiet today doesn't break it; a gap older than yesterday ⇒ 0. |

## Data source

`GET /api/developer/agents/xp` (`src/app/api/developer/agents/xp/route.ts`) — owner-gated (`workspace_members.role='owner'`, 403 otherwise), returns `{ xp: DirectorXpMap }`. The [[../dashboard/agents|Agents hub]] fetches it once and renders the [[director-xp|XP card]] on each director's row (atop its board channel) + on the director profile page (`/dashboard/agents/[role]`).

## Related

[[../specs/directors-board-gamified]] · [[director-board]] · [[director-activity]] · [[brain-roadmap]] · [[../tables/agent_jobs]] · [[../tables/approval_decisions]] · [[../tables/director_activity]] · [[../dashboard/agents]] · [[../goals/devops-director]] · [[../operational-rules]]
