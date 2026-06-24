# ada-director-spec-status-cards-fix-tooling-fa6848

**Owner:** [[../functions/platform]]
**Parent:** [[../specs/ada-director-spec-status-cards]]
**Priority:** critical

**Status:** ⏳ Planned

## Why

Auto-authored by Ada (Platform/DevOps Director) from a parked security-review on [[../specs/ada-director-spec-status-cards]] (job fa6848a7, class `tooling_failure`).

The build of [[../specs/ada-director-spec-status-cards]] parked because the agent itself failed to produce a verdict (the security-review pipeline's tooling, not the origin's content). Fix the tool so the origin's build can run cleanly.

### Evidence

```
Park reason: security review produced no parseable verdict after 2 attempts — re-run or review manually: nputTokens":41878,"webSearchRequests":0,"costUSD":0.7348914999999999,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"c96
Log tail: putTokens":41878,"webSearchRequests":0,"costUSD":0.7348914999999999,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"c963efe6-c592-45a0-982a-4da92318acb0"}
Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.

```

## Phases

### Phase 1 — diagnose + fix
- ⏳ Read the parked job's reason + log tail above. Trace the failure into the implicated code path.
- ⏳ Author the minimum change that unblocks the origin (a new surface, a schema migration, a tooling
  guard, or a corrected agent prompt — whichever the trace points to).
- ⏳ Verify: re-running the origin build should now produce a non-parked verdict.

## Verification

- The origin spec [[../specs/ada-director-spec-status-cards]] builds without re-parking under class `tooling_failure`.
- (For `tooling_failure`) the agent that parked produces a parseable verdict on a fresh invocation
  against a representative input.
