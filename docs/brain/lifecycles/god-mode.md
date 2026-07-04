# god-mode

The founder's ELEVATED bridge to the box for incident remediation. A deliberate **sunset stopgap** — the manual full-power founder bridge to the box while the autonomous CEO/director exec layer doesn't yet exist. Retired once the CEO-mode exec layer can self-remediate. See [[../specs/god-mode]] · [[../functions/ceo]] · [[../tables/god_mode_sessions]] · [[../tables/god_mode_approvals]].

## North-star (supervisable autonomy)

God-mode is the founder's **manual supervisor** bridge over a full-power box session. Every mutation the box makes is COUNTER-SIGNED by the founder via [[../tables/god_mode_approvals]] — never a silent proxy-optimizer. When the CEO exec layer can carry this supervision itself, god-mode retires.

## What's in the same PR (Phase 1)

- **Migration** — `supabase/migrations/20260908120000_god_mode_sessions_and_approvals.sql` creates [[../tables/god_mode_sessions]] + [[../tables/god_mode_approvals]] + adds `workspaces.god_mode_pin_hash` (see below). Applied via `scripts/apply-god-mode-sessions-migration.ts`.
- **SDK chokepoint** — [[../libraries/god-mode]] (`src/lib/god-mode.ts`): `armSession`, `disarmSession`, `getActiveSession`, `getSessionByToken`, `newCockpitToken`, `cockpitUrl`, `hashPin`, `verifyPin`, `SLIDING_TTL_MS`, `ABSOLUTE_TTL_MS`.
- **Arm/disarm routes** — `POST /api/god-mode/arm` (owner-gated, returns the `/god/{token}` URL) + `POST /api/god-mode/disarm` (owner-gated OR cockpit-token authed).
- **Disposable PIN setter** — `scripts/_set-god-mode-pin.ts`. Reads the PIN from env, scrypt-hashes via `hashPin`, writes ONLY the hash to `workspaces.god_mode_pin_hash`. The plaintext PIN never enters source, never enters the DB, never enters shell history (recommended invocation: `read -s GOD_MODE_PIN && export GOD_MODE_PIN && WORKSPACE_ID=<uuid> npx tsx scripts/_set-god-mode-pin.ts && unset GOD_MODE_PIN`).

## Arm/disarm flow (Phase 1)

```
Owner taps 'Arm' in dashboard (Phase 4) — or POSTs /api/god-mode/arm directly
  → requireOwner (workspace_members.role='owner')
  → armSession(admin, { workspaceId, createdBy })
      → if an armed session already exists: REFRESH cockpit_token + reset TTLs
        (one-active-session-per-workspace enforced by a partial UNIQUE index)
      → else: INSERT { status='armed', cockpit_token: 48-hex, token_expires_at: +20min,
                       absolute_expires_at: +12h }
  → response: { cockpit_url: `${SITE_URL}/god/${cockpit_token}` }

Founder taps 'Disarm' (or the cockpit's kill switch)
  → POST /api/god-mode/disarm
      → cockpit_token in body? auth is the token itself (no cookie required)
      → else: requireOwner + workspaces.active session
  → disarmSession → status='disarmed', cockpit_token=NULL, disarmed_at=now()
  → Phase 2+ box lane sees the flip and tears down its `claude -p` session.
```

## Session model

One [[../tables/god_mode_sessions]] row per session. `status ∈ armed|disarmed|expired`. `armed` is enforced UNIQUE per `workspace_id` (partial UNIQUE index). See the table page for column details.

## Tokens & TTLs

- `cockpit_token` — 48-char hex, minted by `newCockpitToken()`, matches the [[journey_sessions]] token size. UNIQUE across live tokens; NULLED on disarm/expire.
- `token_expires_at` — SLIDING. Every Phase-3 GET/message/approve + every Phase-2 box turn bumps this forward `SLIDING_TTL_MS` (~20min). The Phase-5 reaper expires idle sessions past this WITH no in-flight signal.
- `absolute_expires_at` — HARD ceiling. `arm() + 12h`. Never bumped. The Phase-5 reaper force-disarms past this regardless of activity.
- `last_activity_at` — separate liveness bump; distinguishes "idle but not yet expired" from "recently active" for the reaper.

## Founder PIN

Stored ONLY as a one-way scrypt hash on [[../tables/workspaces]].`god_mode_pin_hash`:

- Format: `scrypt:v1:<saltHex>:<hashHex>` — 16-byte random salt, `N=2^15, r=8, p=1, keylen=32`.
- Hashed by [[../libraries/god-mode]] `hashPin(pin)` — takes plaintext ONLY in memory.
- Verified by `verifyPin(candidate, stored)` — constant-time (`timingSafeEqual`); no plaintext compare, no leak on mismatch beyond allow/deny.
- Set OUT-OF-BAND via `scripts/_set-god-mode-pin.ts` (env-fed, disposable, `_`-prefix / do-not-ship convention).
- USED in Phase 3 — approving a `risk='destructive'` [[../tables/god_mode_approvals]] row requires a valid PIN before flipping `status` to `approved`.

## Phase 2 — full-power box lane + live permission gate

The founder posts a message (via the Phase-3 cockpit or the Phase-4 dashboard tab), which enqueues an `agent_jobs` row with `kind='god-mode'` and `instructions = { session_id, mode: 'turn' | 'kill', user_message? }`. The box worker's concurrency-1 god-mode lane claims it and runs `runGodModeJob` (see `scripts/builder-worker.ts`).

### Sandbox: the `godmode` env mode

The box has three env modes for `runBoxSession` (see `scripts/builder-worker.ts` around the sandbox branch):

- **`build`** — strips `SECRET_RE` (no `SUPABASE_SERVICE_ROLE_KEY`, no `SUPABASE_DB_URL`, no `GITHUB_TOKEN`, etc). Keeps `NEXT_PUBLIC_*`. Used by the feature-build sandbox + pr-resolve worktree — the LLM must not be able to push, mutate prod DB, deploy.
- **`max`** — keeps every env var, drops only `ANTHROPIC_API_KEY` (so all inference is Max-billed). Used by every read-only-by-convention Max lane.
- **`godmode`** — DELIBERATELY prod-write. Env-wise identical to `max` (forwards `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DB_URL` / `GITHUB_TOKEN` / deploy creds — the same creds `build` strips), drops `ANTHROPIC_API_KEY`. Distinct branch as an EXPLICIT INTENT MARKER — grep-able + auditable. The trust boundary is NOT env stripping (there is none vs max), it's the hard per-tool permission gate below.

### The hard permission gate

Unlike every other box lane, the `god-mode` `claude -p` invocation is spawned WITHOUT `--dangerously-skip-permissions`. Instead, `runGodModeJob` passes an inline `--settings` JSON that wires a **PreToolUse hook** to the box-side gate:

```
--settings '{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"npx tsx <REPO>/scripts/god-mode-permission-gate.ts"}]}]}}'
```

And an env var `GOD_MODE_SESSION_ID=<uuid>` so the gate knows which session's approval queue to write.

For every tool call the box tries, the CLI pipes the PreToolUse event (`{ tool_name, tool_input, ... }`) to the gate on stdin. The gate:

1. **Bails fast** if the session isn't `armed` anymore (the founder disarmed while the box was mid-call) — returns `deny`.
2. **Classifies** the call:
   - **safe** — `Read`/`Grep`/`Glob`/`WebSearch`/`WebFetch`, task-tracking tools, and Bash matching a **read-only allowlist** (`git status/diff/log/show/branch/ls-files/rev-parse/config --get`, `ls`, `cat`, `pwd`, `wc`, `head`, `tail`, `find`, `which`, `printf`, `node -v`, `npm -v`, `npx tsc --noEmit`, `grep`, `rg`, `gh pr list/view`, `gh issue list/view`, `gh run list/view`, and `psql -c 'SELECT …'` without a second statement). Auto-allow — no `god_mode_approvals` row.
   - **destructive** — deterministic rail over the command text: `rm -rf`, `rmdir`, `git push --force`, `git reset --hard`, `git clean -f`, `git branch -D`, `DROP TABLE/DATABASE/…`, `TRUNCATE`, `DELETE FROM`, `ALTER TABLE … DROP`, `supabase db reset|push`, `vercel … --prod`. Land a row with `risk='destructive'`.
   - **write** — everything else non-safe. Land a row with `risk='write'`.
3. **Polls** the approval row every 2s until it leaves `pending`:
   - `approved` → return `{ hookSpecificOutput: { permissionDecision: 'allow' } }`; the tool executes.
   - `denied` → return `deny`; the box tool call is blocked and the session continues without it.
   - `asked` → return `deny` with the founder's `question_text` in `permissionDecisionReason` so the box reads it in the tool's reject-reason and can respond in-transcript, then re-request approval on the next tool call. **A live back-and-forth, not a dead end.**

For `risk='destructive'` cards, Phase 3's `/api/god/[token]/approve` route additionally verifies the founder PIN against `workspaces.god_mode_pin_hash` (via `verifyPin` — constant-time) BEFORE flipping the row to `approved`. The gate itself just waits — it never sees the PIN.

### Turn flow

```
job.instructions = { session_id, mode: 'turn', user_message }
  → runGodModeJob loads god_mode_sessions row; guards status==='armed'
  → appendMessage(session_id, { role: 'user', content: user_message })
  → stable per-session worktree at builds/god-mode-<session_id> (fresh on origin/main;
    same path across turns so `claude --resume` finds the transcript store)
  → withAccountFailover(prior box_session_id + config_dir) — round-robin fresh, pin resume
  → runGodModeClaude → runBoxSession({
       kind: 'god-mode', sandbox: 'godmode', timeout: 60min,
       permissionGate: { hookCommand: 'npx tsx <REPO>/scripts/god-mode-permission-gate.ts' },
       extraEnv: { GOD_MODE_SESSION_ID: <session_id> },
     })
  → every non-safe tool call blocks on god_mode_approvals until the founder decides
  → parse final JSON { status:'replied', reply:'...' } → appendMessage assistant
  → setBoxSession(box_session_id, box_session_config_dir) — pin the resume for next turn
  → bumpActivity — sliding TTL + last_activity_at (Phase-5 in-flight signal)
```

### Kill mode

```
job.instructions = { session_id, mode: 'kill' }
  → runGodModeJob → disarmSession(sessionId) — status='disarmed', cockpit_token=NULL.
```

The currently running `claude -p` session (if any) sees the session flip next time the gate polls and denies its next tool call.

### In-flight signal (holds Phase-5 reaper open)

The Phase-5 reaper only expires a session when `now() > token_expires_at` AND `hasInFlight(sessionId) === false`. A pending approval row holds the door open indefinitely, and `bumpActivity` on every turn stream keeps `token_expires_at` sliding forward.

## Phase 3+ — deliberately out of scope for this PR

Phase 3 (cockpit token page + Chat + Approvals tabs), Phase 4 (in-app tab), Phase 5 (SMS + reaper) all build on the Phase-2 lane + gate. See the individual phases in [[../specs/god-mode]]. The tables + SDK + arm/disarm + box lane + gate here are wired to make ALL of them land cleanly.

## Sunset

Retire the whole feature (drop the two tables + the workspaces column + delete `src/lib/god-mode.ts` + delete the routes) once the CEO exec layer covers the incident remediation surface. Self-contained by construction (no shared tables, no shared columns beyond one workspaces column) — removal is a one-migration + one-PR cleanup.

## Status / open work

- Phase 1 (session model + arm/disarm + PIN): ✅ shipped.
- Phase 2 (full-power box lane + live permission gate): ✅ shipped.
- Phase 3 (SMS cockpit — token page with Chat + Approvals tabs): ⏳ planned.
- Phase 4 (in-app dashboard God Mode tab): ⏳ planned.
- Phase 5 (SMS delivery + lifecycle reaper): ⏳ planned.
