# fix-vault-post-merge-diff-backstop-7fbde-fix-tooling-e84112

**Owner:** [[../functions/platform]]
**Parent:** [[../specs/fix-vault-post-merge-diff-backstop-7fbde0]]
**Status:** ⏳ Planned

## Why

Auto-authored by Ada (Platform/DevOps Director) from a parked build on [[../specs/fix-vault-post-merge-diff-backstop-7fbde0]] (job e84112e4, class `tooling_failure`).

The build of [[../specs/fix-vault-post-merge-diff-backstop-7fbde0]] parked because the agent itself failed to produce a verdict (the build pipeline's tooling, not the origin's content). Fix the tool so the origin's build can run cleanly.

### Evidence

```
Park reason: branch pushed but PR creation failed
Log tail: s":250},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-opus-4-7":{"inputTokens":19,"outputTokens":10491,"cacheReadInputTokens":1883045,"cacheCreationInputTokens":125421,"webSearchRequests":0,"costUSD":2.4581025,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"7d8c7078-b2fb-4198-b2bb-301cdcef1767"}

```

## Phases

### Phase 1 — diagnose + fix
- ⏳ Read the parked job's reason + log tail above. Trace the failure into the implicated code path.
- ⏳ Author the minimum change that unblocks the origin (a new surface, a schema migration, a tooling
  guard, or a corrected agent prompt — whichever the trace points to).
- ⏳ Verify: re-running the origin build should now produce a non-parked verdict.

## Verification

- The origin spec [[../specs/fix-vault-post-merge-diff-backstop-7fbde0]] builds without re-parking under class `tooling_failure`.
- (For `tooling_failure`) the agent that parked produces a parseable verdict on a fresh invocation
  against a representative input.
