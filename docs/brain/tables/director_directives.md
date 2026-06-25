# tables/director_directives

A director's **active directive** — a plan the CEO hands it via the coaching seat's `plan` intent ([[../libraries/platform-director]]), CEO-approved, that the standing pass runs FIRST (before routine lanes) and which can GATE the build queue until a named spec ships. One active directive per `(workspace_id, director_function)` (partial unique index `director_directives_one_active`).

**Migration:** `supabase/migrations/20260706160000_director_directives.sql` · **Lib:** [[../libraries/director-directives]]

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `workspace_id` uuid | |
| `director_function` text | e.g. `platform` (Ada) |
| `summary` text | the plan in one line |
| `steps` jsonb | ordered plan steps (strings), surfaced + pursued first |
| `gate_builds_until` text | a spec slug; while it's unshipped, the build-enqueue lanes pause for every spec except it. NULL = no gate |
| `status` text | `active` \| `done` \| `cleared` — a new directive supersedes (clears the prior); auto-`done` when the gate spec ships |
| `created_by` uuid | the CEO who approved it |
| `created_at` / `completed_at` | |

## How it's used
- Created by the coaching seat's `directive` card (`scripts/builder-worker.ts` `runDirectorCoachJob` → `createDirective`).
- `runPlatformDirectorStandingPass` headlines the active directive each pass (`🎯 active directive: …`).
- The build lanes ([[../libraries/platform-director]] `escortApprovedGoals` / `escortFixSpecs` / `findInitCandidates`) call `buildGate` and skip enqueuing any spec but the gate spec while gated. The gate **auto-lifts** (and the directive auto-completes) when the gate spec's status is `shipped` — so a gate can never permanently stall the line. The CEO can also clear it.

## Gotchas
- `action_kind` on [[director_activity]] logs `directive_accepted` when a directive is approved (free-text column — no CHECK).
- The gate **fails open**: any error in `buildGate` returns null (no gate) so a transient read never stalls building.
