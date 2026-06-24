# libraries/director-directives

The **active-directive** store + build-gate ([[../specs/director-executable-plans-and-priority]]). A directive is a CEO-handed plan (via the coaching seat's `plan` intent) that the director's standing pass runs FIRST and which can pause the build queue until a fix ships.

**File:** `src/lib/agents/director-directives.ts` · **Table:** [[../tables/director_directives]]

## Exports
- **`getActiveDirective(admin, workspaceId, directorFunction)`** → `DirectorDirective | null` — the one active directive.
- **`createDirective(admin, { workspaceId, directorFunction, summary, steps?, gateBuildsUntil?, createdBy? })`** → `{ ok, id?, error? }` — clears any existing active directive, then inserts the new one active (a new directive supersedes). Sanitizes the gate slug + caps steps.
- **`completeDirective(admin, id)`** → marks `status='done'` + `completed_at`.
- **`buildGate(admin, workspaceId, directorFunction)`** → `{ gatedUntil } | null` — the gate the build lanes consult. Null when there's no active directive, no gate set, or the gate spec has shipped (in which case it **auto-completes** the directive, lifting the gate). **Fails open** (returns null on any error) so a read failure never stalls building.
- **`gateAllowsBuild(gate, specSlug)`** → boolean — `true` if not gated, or the spec IS the gate spec.
- **`enqueuePriorityBuild(admin, ws, slug, createdBy, reason)`** → boolean — queue a build for `slug` now unless it's in-flight or shipped (the directive executor calls this for the gate spec + every critical spec on the accept pass, so a priority spec never sits un-built).
- **`holdBuilds(admin, ws, slugs)`** → `string[]` — cancel PARKED out-of-order builds (queued/needs_input/needs_approval/blocked — never an actively-building one); terminal `completed` + note. Disruptive → only from a CEO-approved directive (`holdBuilds` field).
- **`selfWatchOperations(admin, ws, fn)`** → `{ notes, healed, stuck }` — the standing-pass self-watch: self-heals a **gate deadlock** (queues the gate spec if nothing's building it) + flags builds stuck >90m. The autonomous "discover the jam, then act" loop.

**Gate semantics (hardened):** the gate pauses only the **non-critical routine backlog** — the gate spec + every `**Priority:** critical` spec still build, so a directive's priority builds actually unjam the line ([[platform-director]] lanes check `!card.critical`).

## Callers
- `scripts/builder-worker.ts` — `runDirectorCoachJob` (`createDirective` on an approved `directive` card) + `runPlatformDirectorStandingPass` (`getActiveDirective` headline).
- [[platform-director]] — `escortApprovedGoals` / `escortFixSpecs` / `findInitCandidates` call `buildGate` and skip every non-gate build while gated (`findInitCandidates` also sorts `**Priority:** critical` specs first).

## North star
A directive re-prioritizes WHAT the director does, never loosens HOW — the leash/loop-guard/escalation rails are unchanged, the CEO approves every directive, and the gate auto-lifts on ship (no permanent stall).
