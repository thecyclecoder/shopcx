# ada-director-spec-status-cards-fix-tooling-fa6848

**Owner:** [[../functions/platform]]
**Parent:** [[../specs/ada-director-spec-status-cards]]
**Priority:** critical

**Status:** 🚧 In progress (Phase 1 built — needs an origin re-build to confirm in production)

## Why

Auto-authored by Ada (Platform/DevOps Director) from a parked security-review on [[../specs/ada-director-spec-status-cards]] (job fa6848a7, class `tooling_failure`).

The build of [[../specs/ada-director-spec-status-cards]] parked because the agent itself failed to produce a verdict (the security-review pipeline's tooling, not the origin's content). Fix the tool so the origin's build can run cleanly.

### Evidence

```
Park reason: security review produced no parseable verdict after 2 attempts — re-run or review manually: nputTokens":41878,"webSearchRequests":0,"costUSD":0.7348914999999999,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"c96
Log tail: putTokens":41878,"webSearchRequests":0,"costUSD":0.7348914999999999,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"c963efe6-c592-45a0-982a-4da92318acb0"}
Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.

```

Sibling park 69594acf showed the IDENTICAL shape (same `permission_denials` / `terminal_reason` envelope ending, same stdin warning, different cost / uuid). [[iteration-ingest-async-reports-fix-tooling-69594a]] tried the same-session parse-repair on that one — and the SAME failure mode still re-fired on fa6848a7 with the parse-repair already shipped. That rules out "model flubbed the envelope" as the sole cause — there is a tooling layer underneath that the repair never gets to recover from.

## Phases

### Phase 1 — diagnose + fix ✅

**Built 2026-06-24.** Two strictly-additive fixes in `scripts/builder-worker.ts`:

1. **`shAsync` now closes stdin** (`stdio: ["ignore", "pipe", "pipe"]`). The default `child_process.spawn` left stdin as an open, never-written pipe — newer `claude -p` CLI versions wait 3s on that and emit the warning visible in the evidence ("Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: `< /dev/null` to skip, or wait longer."). The CLI explicitly recommends `< /dev/null`; `stdio: ["ignore", …]` is the in-process equivalent. The wasted 3s wait was the most visible symptom under EVERY parked tooling_failure (fa6848a7 + 69594acf), and the prior same-session parse-repair shipped from [[iteration-ingest-async-reports-fix-tooling-69594a]] never recovered the verdict on fa6848a7 — pointing at a tooling layer below the repair. Strictly additive: every `claude -p`/`git`/`npx tsc`/`bash -lc` caller already passes its full input via `-p prompt` or argv; none read from stdin.

2. **`extractJson` walks every fenced block (last-wins) and scans the LAST balanced `{…}`.** The prior implementation tried one fenced block then the widest `text.indexOf("{") … text.lastIndexOf("}")` span — which is fragile when the model emits example JSON in earlier prose, or a JSON-shaped excerpt from the reviewed diff appears in the review text BEFORE the verdict envelope. The new scan: every `` ```json `` fence (last to first) → then a right-to-left close × left-to-right open pass over the raw text, returning the first balanced span that parses. Finds MORE valid JSONs, never fewer — the prior greedy span is a strict subset of the new search. This protects every caller of `extractJson` (security-review + repair + regression-review + solver/skeptic).

The fail-safe reason on exhaustion is unchanged (`"security review produced no parseable verdict after 2 attempts — re-run or review manually: <excerpt>"`), so the auto-router's `tooling_failure` classification and the human-actionable park reason stay correct on a genuine novel failure.

## Verification

- Open `scripts/builder-worker.ts` → expect the `shAsync` `spawn` call to pass `stdio: ["ignore", "pipe", "pipe"]` with a comment naming this spec; expect `extractJson` to iterate `text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)` last-wins and walk the right-to-left close × left-to-right open scan.
- Run `npx tsc --noEmit` from the repo root → expect zero errors (the change is type-additive — `stdio` is a valid `SpawnOptions` field; the new `extractJson` returns the same `T | null` shape).
- Origin re-build of [[../specs/ada-director-spec-status-cards]] → expect the security-review claude run no longer emits "Warning: no stdin data received in 3s" on stderr, and produces a parseable `{"status":"clean" | "false-positive" | "needs-human" | "real-vuln"}` verdict on attempt 1 (no parse-repair needed) — `agent_jobs.status` lands `completed` or `needs_approval`, not `needs_attention` with `needs_attention_class='tooling_failure'`.
- The next 7-day window of `agent_jobs` parked under `needs_attention_class='tooling_failure'` whose `error` matches `/no parseable verdict/` should hold at zero for the security-review, repair, and regression-review kinds (the extractJson improvement protects all three, the stdin close protects every claude invocation in the box).
- Sibling spec [[iteration-ingest-async-reports-fix-tooling-69594a]] flips ✅ once the same window of zero parked tooling_failures confirms the layered fix (parse-repair from 69594a + stdin close + extractJson from fa6848) holds together.
