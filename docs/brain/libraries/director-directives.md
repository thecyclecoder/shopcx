# libraries/director-directives

The **active-directive** store + build-gate ([[../specs/director-executable-plans-and-priority]]). A directive is a CEO-handed plan (via the coaching seat's `plan` intent) that the director's standing pass runs FIRST and which can pause the build queue until a fix ships.

**File:** `src/lib/agents/director-directives.ts` · **Table:** [[../tables/director_directives]]

## Exports
- **`getActiveDirective(admin, workspaceId, directorFunction)`** → `DirectorDirective | null` — the one active directive.
- **`createDirective(admin, { workspaceId, directorFunction, summary, steps?, gateBuildsUntil?, createdBy? })`** → `{ ok, id?, error? }` — clears any existing active directive, then inserts the new one active (a new directive supersedes). Sanitizes the gate slug + caps steps.
- **`completeDirective(admin, id)`** → marks `status='done'` + `completed_at`.
- **`buildGate(admin, workspaceId, directorFunction)`** → `{ gatedUntil } | null` — the gate the build lanes consult. Null when there's no active directive, no gate set, or the gate spec has shipped (in which case it **auto-completes** the directive, lifting the gate). **Fails open** (returns null on any error) so a read failure never stalls building.
- **`gateAllowsBuild(gate, specSlug)`** → boolean — `true` if not gated, or the spec IS the gate spec.

## Callers
- `scripts/builder-worker.ts` — `runDirectorCoachJob` (`createDirective` on an approved `directive` card) + `runPlatformDirectorStandingPass` (`getActiveDirective` headline).
- [[platform-director]] — `escortApprovedGoals` / `escortFixSpecs` / `findInitCandidates` call `buildGate` and skip every non-gate build while gated (`findInitCandidates` also sorts `**Priority:** critical` specs first).

## North star
A directive re-prioritizes WHAT the director does, never loosens HOW — the leash/loop-guard/escalation rails are unchanged, the CEO approves every directive, and the gate auto-lifts on ship (no permanent stall).
