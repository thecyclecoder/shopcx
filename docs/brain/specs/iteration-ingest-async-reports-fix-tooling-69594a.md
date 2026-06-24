# iteration-ingest-async-reports-fix-tooling-69594a

**Owner:** [[../functions/platform]]
**Parent:** [[../specs/iteration-ingest-async-reports]]
**Status:** 🚧 In progress (Phase 1 built — needs an origin re-build to confirm in production)

## Why

Auto-authored by Ada (Platform/DevOps Director) from a parked security-review on [[../specs/iteration-ingest-async-reports]] (job 69594acf, class `tooling_failure`).

The build of [[../specs/iteration-ingest-async-reports]] parked because the agent itself failed to produce a verdict (the security-review pipeline's tooling, not the origin's content). Fix the tool so the origin's build can run cleanly.

### Evidence

```
Park reason: security review ended without a recognizable verdict
Log tail: utTokens":26543,"webSearchRequests":0,"costUSD":0.46964649999999997,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"42e28994-72bc-4a97-81b0-46f5bfde22a6"}
Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.

```

## Phases

### Phase 1 — diagnose + fix ✅
**Built 2026-06-24.** The trace pointed at `scripts/builder-worker.ts:resolveReviewVerdict` — the shared verdict-resolution helper for security/repair/regression agents. The parked security-review claude run COMPLETED (`terminal_reason: "completed"`, ~$0.47 spent, ~26.5k output tokens) but its `result` field carried no parseable `{"status":...}` envelope. The existing retry path then ran a SECOND fresh investigation from scratch — which (per the same model tendency that flubbed the first envelope) produced no parseable verdict either, and the job parked.

**Fix:** wire the spec-test agent's proven parse-repair re-prompt pattern (builder-worker.ts:4649) into the shared `resolveReviewVerdict` helper, then opt the security-review path in.
- `scripts/builder-worker.ts` `resolveReviewVerdict` — added an optional `repair: (priorSession) => Promise<T>` field. When set AND attempt 1 emitted a session id, attempt 2 becomes a cheap same-session re-prompt asking ONLY for the JSON envelope (the model already has all findings in context) instead of a wasted fresh re-investigation. Callers without `repair` keep the original 2-fresh-attempt semantics — zero behavior change for repair-agent + regression-agent.
- `scripts/builder-worker.ts` `securityReviewRepairPrompt()` + the security-review `resolveReviewVerdict` call site — the new repair prompt enumerates all four recognized envelope shapes (`clean` / `false-positive` / `needs-human` / `real-vuln`) and explicitly forbids re-investigation. Wired into the security-review path so attempt 2 is now the parse-repair (not a fresh re-run).
- `docs/brain/libraries/security-agent.md` — documents the parse-repair step in the verdict-robustness bullet.

The fail-safe reason on exhaustion is unchanged (`"security review produced no parseable verdict after 2 attempts — re-run or review manually: <excerpt>"`), so the auto-router's `tooling_failure` classification and the human-actionable park reason stay correct.

## Verification

- The origin spec [[../specs/iteration-ingest-async-reports]] builds without re-parking under class `tooling_failure`. — pending the next merged build of that origin triggering a fresh security review pass; the parse-repair step should now recover the verdict if the model again flubs the envelope shape on attempt 1.
- (For `tooling_failure`) the agent that parked produces a parseable verdict on a fresh invocation against a representative input. — covered by the parse-repair re-prompt: any first attempt that emits a session id (the normal case) now gets a second chance to emit the recognized envelope without paying for another full investigation.
