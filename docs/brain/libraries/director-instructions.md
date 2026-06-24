# `src/lib/agents/director-instructions.ts` — the CEO→Director coaching store + injection

The top rung of the cascade: the CEO coaches the Platform/DevOps Director (Ada) the same way she coaches her workers ([[worker-instructions]]), one level UP ([[../specs/worker-grading-and-director-management]] Phase 7). Persists to [[../tables/director_instructions]] + [[../tables/director_coaching_log]]; the durable half of the [[director-coach-threads|coaching chat]].

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `loadDirectorInstructions` | `(admin, workspaceId, directorFunction) → Promise<DirectorInstruction[]>` | Her ACTIVE guidance, newest-first. Best-effort ([] if the table's absent). |
| `formatDirectorInstructions` | `(instructions) → string` | Render as a prompt block ("Coaching from the CEO — obey these"). |
| `appendDirectorInstructions` | `(admin, workspaceId, directorFunction, basePrompt) → Promise<string>` | The RUNTIME load — append her active coaching to a base prompt. Never throws. |
| `coachDirector` | `(admin, input) → Promise<CoachDirectorResult>` | The CEO-GATED write: amend her instruction set (new active version superseding the prior for the class) + log the CEO→director message. Requires `coachedBy`. |
| `getDirectorCoachingHistory` | `(admin, workspaceId, directorFunction, limit?) → Promise<DirectorCoachingEntry[]>` | Her coaching history for her profile. |

## Where it's wired
- **Write** — [[../tables/director_coach_threads|the coaching chat]]: on the CEO approving a `coaching` card, `runDirectorCoachJob` (mode `approve_action`) calls `coachDirector(coachedBy:'ceo', sourceThreadId)`.
- **Injection** — `scripts/builder-worker.ts`: `appendDirectorInstructions` wraps the director's **approval-investigation** prompt (`runPlatformDirectorJob`) AND her **board-grooming** prompt (`groomBoard`) before each `runDirectorClaude`, so a coached rule actually steers her next call. (Her fully-deterministic escort rules — `escortApprovedGoals`/`escortFixSpecs` — are governed by the leash, not a prompt; coaching steers her LLM judgment calls.)

## Gotchas
- **CEO-gated, never self-coached** — `coachedBy` is required + the tables are service-role-write-only; the director's read-only box session can't edit her own rules ([[../operational-rules]] § North star).
- **Versioned + reversible** — one active instruction per (director, class); a re-coach supersedes in place.
- **Best-effort load** — a missing migration / read error is a clean no-op (her prompt is unchanged), never a crash.

---

[[../README]] · [[../tables/director_instructions]] · [[../tables/director_coaching_log]] · [[../tables/director_coach_threads]] · [[director-coach-threads]] · [[worker-instructions]] · [[platform-director]] · [[../specs/worker-grading-and-director-management]] · [[../../CLAUDE]]
