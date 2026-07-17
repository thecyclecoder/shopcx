# libraries/box-session-resume

The one place every RESUMABLE box-chat lane routes through so a resumed run whose session id is gone from its owning account retries ONCE with `sessionId=null` (rebuilding full context from the thread transcript) instead of hard-wedging on the dead id.

**File:** `src/lib/box-session-resume.ts`

## Why this exists

[[../specs/box-chat-resume-falls-back-fresh-on-missing-session]]. An Ask-Ada ([[director-coach-threads]]) turn wedged: every new turn errored with `No conversation found with session ID: c4d80812-…`, `num_turns=0`, so the CEO's message never reached Ada and the thread stuck at `turn_status='error'`. Root cause: `runDirectorCoachJob` resumes the thread's stored `box_session_id`, but that session was gone from the box (restart / session-store cleanup / expiry). The account-pool failover already handled CAPPED accounts and cross-account pinning, but NOT a session that was simply missing on its own account — so the resume errored and the turn died with no retry. The same resume-without-fresh-fallback shape existed in the sibling resumable box-chat lanes (`dev-ask`, `roadmap-chat` / spec-chat, `ticket-improve`), so the whole class was closed at once instead of just the one thread.

## Hard rule

**Every resumable box-chat lane MUST route its turn through `runBoxTurnWithFreshFallback` and persist the returned session id via `pickNextSession`.** A hand-rolled `withAccountFailover({ sessionId }, …)` → `failTurn(isError ? …)` on a resumed lane is a REGRESSION of this class — the very hole [[../specs/box-chat-resume-falls-back-fresh-on-missing-session]] closed. When adding a NEW resumable box-chat surface, mirror the existing four (`director-coach`, `dev-ask`, `spec-chat`, `ticket-improve`) — build the turn prompt INSIDE the failover closure keyed off `sid` (so a fresh restart rebuilds full context from the thread transcript), then wrap the failover call in `runBoxTurnWithFreshFallback` with a lane-appropriate `hasReply`, and persist via `pickNextSession` so a dead id can never be re-saved.

## Exports

- **`isMissingSessionError(raw: string): boolean`** — the pure signature detector. True when the raw box-run output contains `No conversation found with session ID` (case-insensitive so an upstream CLI casing shift doesn't silently downgrade the retry). Unit-tested in `box-session-resume.test.ts` against real signature, log-tail bury, capped-account walls, parse failures, and empty/non-string input.
- **`shouldRetryFresh({ sessionId, isError, reply, raw }): boolean`** — the decision predicate. True when the caller ACTUALLY resumed (sessionId set), the run errored, produced no assistant reply, AND the raw carries the missing-session signature. Direct-use variant of the wrapper for a lane that already has all four values in hand.
- **`runBoxTurnWithFreshFallback({ pin, run, failover, hasReply?, onFreshFallback? })`** — the SHARED wrapper the four resumable lanes route through. Runs `failover(pin, run)` once; on a resumed-run isError with the missing-session signature (and, when `hasReply` is supplied, no reply) it re-invokes `failover({ sessionId: null }, run)` so the same closure rebuilds the transcript-shape prompt. Returns `{ result, configDir, allCapped, freshRetried }`. The wrapper never persists to the DB — the caller does that with `pickNextSession` below.
- **`pickNextSession({ newSession, priorSessionId, raw }): string | null`** — the "never re-save the dead id" guard. Prefer a fresh session id when the retry returned one; else keep the prior id ONLY when its raw doesn't carry the missing-session signature; else null. Every persist site in the four lanes uses this.
- **`FailoverEnvelope<T>` / `FailoverFn<T>` / `BoxRunResultLike`** — the small structural types the wrapper is generic over. Match the return shape of `withAccountFailover` / `runBoxClaude` in `scripts/builder-worker.ts` so the wrapper stays pure + dependency-injected.

## The four lanes that route through this today

Wired in `scripts/builder-worker.ts` (all four in [[../specs/box-chat-resume-falls-back-fresh-on-missing-session]] Phase 2):

- **`runDirectorCoachJob`** mode:'turn' (the Ask-Ada lane that surfaced the wedge) — writes `director_coach_threads.box_session_id`. See [[director-coach-threads]] § Fresh-fallback on a missing box session.
- **`runDeveloperMessageJob`** mode:'turn' — writes `dev_message_threads.box_session_id`.
- **`runSpecChatJob`** modes: turn (+ finalize when there's a chat/session; verify is standalone and the wrapper's `!priorSessionId` guard skips retry) — writes `roadmap_chats.box_session_id`.
- **`runTicketImproveJob`** — writes `ticket_improve_chats.box_session_id`; also preserves `runBoxLane`'s synthetic-when-`allCapped` shape so the downstream isError path still parks `blocked_on_usage`.

## The one lane that uses the PRIMITIVE but NOT the wrapper — and why (copy-author self-heal, 2026-07-17)

Dahlia's copy-author self-heal loop ([[creative-agent]] `runCopyAuthorSession`) also resumes a box session across turns, but it deliberately does **not** route through `runBoxTurnWithFreshFallback`. It uses the shared PRIMITIVE `isMissingSessionError(raw)` directly and owns the fresh-fallback in its OWN loop. This is NOT a regression of the class — the wrapper doesn't fit here:

- The four box-CHAT lanes rebuild the **SAME** conversation prompt from a thread transcript on a fresh retry, so `runBoxTurnWithFreshFallback` can just re-run the identical `run` closure with `sessionId=null`.
- The copy-author loop's fresh turn needs a **DIFFERENT** prompt than its resume turn: a RESUME sends the SHORT `buildCopyAuthorRevisePrompt` (the image+brief+rubric are cached on the session), but a FRESH turn must send the FULL `buildCopyAuthorPrompt` (a fresh session has no cached context). Re-running the same closure would send the short prompt to a context-less session.

So the loop: dispatches (resume or fresh), and its `CopyAuthorSessionDispatcher` reports `{sessionId, sessionConfigDir, missingSession}` where `missingSession = isMissingSessionError(raw)` on a resume (OR an account-cap hop the dispatcher detects via a changed `configDir`). On `missingSession` the loop clears its resume pin and re-dispatches FRESH with the FULL prompt next turn — the same "never wedge on a dead session id" guarantee, reached through the loop instead of the wrapper. When adding another resumable surface whose fresh turn needs a different prompt than its resume turn, mirror THIS pattern (primitive + own-loop fallback), not the wrapper.

## Two-layer split

Same shape as the deterministic gates ([[spec-review-gate]]):

- Pure predicates (`isMissingSessionError`, `shouldRetryFresh`, `pickNextSession`) — no I/O, no dependency on `scripts/builder-worker.ts`; unit-tested in `box-session-resume.test.ts`.
- Dependency-injected wrapper (`runBoxTurnWithFreshFallback`) — takes the failover primitive as an argument so `src/` never imports `scripts/`, and the wrapper stays unit-testable with a stubbed failover.

## What this does NOT do

- Does NOT persist to the DB — the caller writes `box_session_id` via `pickNextSession`.
- Does NOT bypass the account-pool wall — a cap during the retry still hops per `withAccountFailover`; the retry returning `allCapped:true` bubbles up so the caller parks `blocked_on_usage` exactly as before.
- Does NOT retry on a fresh-start run (no prior sessionId) — the wrapper's `!priorSessionId` guard short-circuits so a genuinely-fresh session that happens to log a garbled `No conversation found` line (a transcript quote from a prior conversation, say) can't retry.
- Does NOT retry on a non-missing-session error (usage cap, parse failure, worktree fail) — those flow to the lane's normal failTurn / blocked_on_usage path.

---

[[../README]] · [[director-coach-threads]] · [[../tables/director_coach_threads]] · [[../tables/dev_message_threads]] · [[../tables/roadmap_chats]] · [[../tables/ticket_improve_chats]] · [[../specs/box-chat-resume-falls-back-fresh-on-missing-session]] · [[../../CLAUDE]]
