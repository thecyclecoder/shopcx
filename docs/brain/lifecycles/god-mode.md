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
   - **safe** — `Read`/`Grep`/`Glob`/`WebSearch`/`WebFetch`, task-tracking tools, and Bash matching a **read-only allowlist** (`git status/diff/log/show/branch/ls-files/rev-parse/config --get`, `ls`, `cat`, `pwd`, `wc`, `head`, `tail`, `find`, `which`, `printf`, `node -v`, `npm -v`, `npx tsc --noEmit`, `grep`, `rg`, `gh pr list/view`, `gh issue list/view`, `gh run list/view`, `psql -c 'SELECT …'` without a second statement, and the plan primitive `npx tsx …scripts/god-mode-plan.ts open|close|status …`). Auto-allow — no `god_mode_approvals` row.
   - **destructive** — deterministic rail over the command text: `rm -rf`, `rmdir`, `git push --force`, `git reset --hard`, `git clean -f`, `git branch -D`, `DROP TABLE/DATABASE/…`, `TRUNCATE`, `DELETE FROM`, `ALTER TABLE … DROP`, `supabase db reset|push`, `vercel … --prod`. Land a row with `risk='destructive'`.
   - **write** — everything else non-safe. Land a row with `risk='write'`.
3. **Polls** the approval row every 2s until it leaves `pending`:
   - `approved` → return `{ hookSpecificOutput: { permissionDecision: 'allow' } }`; the tool executes.
   - `denied` → return `deny`; the box tool call is blocked and the session continues without it.
   - `asked` → return `deny` with the founder's `question_text` in `permissionDecisionReason` so the box reads it in the tool's reject-reason and can respond in-transcript, then re-request approval on the next tool call. **A live back-and-forth, not a dead end.**

For `risk='destructive'` cards, Phase 3's `/api/god/[token]/approve` route additionally verifies the founder PIN against `workspaces.god_mode_pin_hash` (via `verifyPin` — constant-time) BEFORE flipping the row to `approved`. The gate itself just waits — it never sees the PIN.

### Plan-scoped approvals (hotfix) — approve the DECISION, not every keystroke

Per-call gating meant one logical decision fanned out into many cards (a "dismiss 4 stale approvals" incident = ~9 rubber-stamps: write-probe → run → write-probe → run → write-fix → run → verify). The fix: a **plan** — a plain-language unit of work the founder approves ONCE. The box investigates read-only (auto-allowed), then runs `npx tsx scripts/god-mode-plan.ts open "<decision>" "step" …` (allowlisted); that raises ONE `risk='plan'` card ([[../libraries/god-mode]] `openPlan`) and polls it. On approval the script points `god_mode_sessions.active_plan_id` at the plan, and the gate then AUTO-ALLOWS the non-destructive mechanical calls that implement it (`getActivePlan` returns the approved open plan → allow, no new card). **Destructive calls still gate individually with the PIN even under a plan** (`cls.risk !== 'destructive'` guard); the Chat tab streams every auto-allowed call and disarm kills mid-flight, so it stays supervisable. A plan is scoped to its turn — `runGodModeJob` clears `active_plan_id` at turn start and `god-mode-plan.ts close` clears it explicitly; no open plan ⇒ pre-hotfix per-call behavior. Mechanism detail: [[../libraries/god-mode-permission-gate]] § Plan-scoped approvals.

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

## Phase 3 — the SMS cockpit at `/god/[token]`

The founder taps the cockpit URL from the (Phase-5) SMS or from the (Phase-4) in-app tab. The page (`src/app/god/[token]/page.tsx`, `"use client"`) resolves the token against `god_mode_sessions` and renders two tabs — Chat + Approvals — off a 2.5s poll of `GET /api/god/[token]`.

Route wrap: `src/app/god/layout.tsx` wraps `{children}` in `<Suspense fallback={null}>` — required by `cacheComponents: true` because the client page reads `useParams()`.

### Routes

All three routes are **service-role only** (`createAdminClient()`) and **token-authed** (no cookie, no user — the 48-hex slug IS the auth, same convention as `/api/journey/[token]`). Every route goes through `resolveCockpitToken(admin, token)` so `not_found` / `disarmed` (→ 404) vs `expired` (→ 410) is decided in one chokepoint.

- `GET /api/god/[token]` → `{ status, messages, approvals, token_expires_at, absolute_expires_at }`. Bumps `token_expires_at` (sliding) + `last_activity_at` (Phase-5 in-flight signal) BEFORE reading approvals so a reaper doesn't race an open cockpit into expiry. Never exposes `workspace_id`, `created_by`, `box_session_id`, or the token itself in the response body.
- `POST /api/god/[token]/message` — body `{ message }`. Appends the founder turn to the transcript, then `enqueueGodModeTurn` inserts a `kind='god-mode'` `mode:'turn'` `agent_jobs` row. The box lane claims + runs `runGodModeJob`. Renews TTL + bumps activity.
- `POST /api/god/[token]/approve` — body `{ approvalId, decision:'approve'|'deny'|'ask', question?, pin? }`. Tamper-guard: the approval MUST belong to the token's session (via `getApprovalForSession`) — else 404 (never 403, to avoid confirming the id exists elsewhere). Idempotent (a call on an already-terminal row returns the row unchanged). On `approve` of `risk='destructive'`: loads `workspaces.god_mode_pin_hash`, refuses if unset (401 `pin_not_set`), refuses on constant-time `verifyPin` mismatch (401 `pin_incorrect` — never reveals validity beyond allow/deny). On `ask`: requires a non-empty `question` — 400 otherwise. Renews TTL + bumps activity on every call.

### Cockpit tab UI

- **Chat tab** — renders `god_mode_sessions.messages`. `[Founder]` bubbles indigo, `[You]` (assistant) neutral, `[System]` muted. Composer supports ⌘/Ctrl+Enter to send. Auto-scrolls to bottom on new messages. 2.5s poll updates the transcript live (no realtime channel — a poll is enough at this cadence and dodges the cross-Suspense channel setup).
- **Approvals tab** — pending float to the top, history below (most-recent first). Each card shows `tool_name`, `preview`, risk badge (`safe|write|destructive`), status badge (`pending|approved|denied|asked`). Pending rows expose three actions:
  - **Approve** — for `risk='destructive'` a PIN input appears above; Approve is disabled until it's non-empty. The client sends `pin` alongside; the route verifies against the stored hash.
  - **Deny** — one click.
  - **Ask** — surfaces a textarea; the founder types a question and the row flips to `status='asked'` + `question_text` is saved. The box gate returns deny-with-the-question so the box reads it in-transcript and can respond, then re-request approval as a new row.
  - On `pin_incorrect` / `pin_not_set` / `question_required` the client renders the error inline (no toast).
- **Disarm button** in the header — hits `POST /api/god-mode/disarm` with `{ cockpit_token }` (Phase-1 kill switch: flips status to `disarmed` + nulls the token).

### Not implemented in Phase 3 (deliberately)

- No realtime Supabase channel — a 2.5s poll is enough at this cadence and dodges the cross-Suspense channel setup. Phase 5's SMS handles cold-visit alerts.
- No file uploads, no rich text — the cockpit is a lifeline console, not a full IDE.

## Phase 4 — in-app dashboard God Mode tab (desk mirror)

The founder isn't always on their phone — Phase 4 mirrors the [[#phase-3--the-sms-cockpit-at-godtoken]] cockpit into the desktop dashboard so an incident can be worked from the desk. Tab lives inside the Developer Message Center at `/dashboard/developer/messages` — see [[../dashboard/developer__messages]].

- **Component** — `src/app/dashboard/developer/messages/GodModeTab.tsx`. Reuses the Phase-3 Chat + Approvals UX (transcript render, pending-first approvals, Approve/Deny/Ask + PIN input for `risk='destructive'`) but hits owner-gated `/api/god-mode/*` routes instead of the cockpit's token-authed routes.
- **Parent wiring** — `src/app/dashboard/developer/messages/MessageCenterChat.tsx` gained a `Tab = 'chat' | 'god'` union + `useState`; the tab bar renders between the header at `:214` and the body at `:216`. The God Mode tab **button** is gated on `isOwner` (workspace.role === 'owner') — non-owners never see it.
- **Controls** — the tab exposes an **Arm god mode** button when nothing is armed (hits `POST /api/god-mode/arm` and reloads the payload) and a **Disarm / kill** button in the session header when armed (hits `POST /api/god-mode/disarm` — the same Phase-1 kill switch).

### Routes (all owner-gated, service-role, workspace-scoped)

Every route calls the SAME `requireOwner()` helper as `/api/developer/messages` — never trust the client. The tab hides the button for non-owners, but the server never assumes the client honored that. Under the covers each route resolves the workspace's active session via `getActiveSession(admin, workspaceId)` — the `cockpit_token` never enters the response (that token stays reserved for the SMS-linked `/god/[token]` cockpit).

- `GET /api/god-mode/session` → `{ armed: false }` OR `{ armed: true, session, messages, approvals }` with the SAME `messages/approvals` public shape as `GET /api/god/[token]`. Bumps sliding TTL + `last_activity_at` on every read.
- `POST /api/god-mode/message` — body `{ message }`. Appends the founder turn + enqueues a `kind='god-mode'` `mode:'turn'` `agent_jobs` row via `enqueueGodModeTurn`. Bumps TTL. 404 when nothing is armed.
- `POST /api/god-mode/approve` — body `{ approvalId, decision, question?, pin? }`. Tamper-guarded via `getApprovalForSession` against the workspace's ACTIVE session (an approvalId from another workspace → 404, never 403). Destructive approve verifies PIN through constant-time `verifyPin`. Idempotent on already-terminal rows.
- `POST /api/god-mode/arm` + `POST /api/god-mode/disarm` — pre-existing Phase-1 routes; the tab is a caller.

### Why the tab (vs just deep-linking the SMS cockpit)

The SMS cockpit was designed for the middle of the night; the desk tab is for daytime work. Same routes underneath (parallel implementation, not a duplicated one) so a fix that lands on one lands on the other with only a `getActiveSession` vs `resolveCockpitToken` swap.

## Phase 5 — SMS delivery + lifecycle reaper

The final piece: **push notification** so the founder learns about an incident even when the app is closed, and a **reaper** so a forgotten armed session doesn't stay hot forever.

### Founder mobile config

The founder mobile number is a **SECURE CONFIG** value, never hardcoded in source:

1. **Workspace column** — `workspaces.god_mode_sms_number` (plain text — a phone number isn't a cryptographic secret; same convention as `twilio_phone_number`). Added by `supabase/migrations/20260909120000_god_mode_sms_number.sql` (idempotent `ADD COLUMN IF NOT EXISTS`).
2. **Env fallback** — `process.env.GOD_MODE_FOUNDER_PHONE` if the workspace column is unset.

Resolution: workspace column FIRST, then env. Both unset → SMS is a silent no-op (god mode still works via the dashboard tab and the cockpit; the founder just doesn't get pushed).

Resolved by `resolveFounderPhone(admin, workspaceId)` in [[../libraries/god-mode]].

### SMS delivery — three events, one persistent cockpit URL

Send is best-effort — every emit site fires-and-forgets so a Twilio outage never blocks a mutation. Delivery goes through `sendSMS()` in [[../libraries/twilio]] (the workspace's `twilio_phone_number` is the From; body ends with the cockpit URL where relevant).

- **arm** — `armSession()` fires ONE SMS with the cockpit URL. `"God mode armed. Cockpit:\n\n<url>"`. A re-arm on an already-armed workspace refreshes the token AND resends the SMS with the refreshed URL.
- **approval (5-min nudge, NOT per-approval)** — `openApproval()` sends NOTHING on insert. Instead the 60s `nudgeStalePendingApprovals` sweep texts ONCE only if an approval has sat `pending` and un-answered for `APPROVAL_NUDGE_AFTER_MS` (5 min): `"God mode: <tool> (<risk>) has been waiting 5+ min for your approval. Approvals tab:\n\n<url>"`, or batched `"God mode: <n> approvals have been waiting 5+ min…"` when several piled up. `god_mode_approvals.sms_notified_at` is stamped on send so the same rows never re-text (a new card that later crosses 5 min re-nudges). **Same cockpit URL every time** — deep-links to the Approvals tab. This replaced the old fire-on-every-insert behavior (too noisy — every gated call pinged the founder). With plan-scoped approvals most calls auto-allow and never create a card at all, so in practice the only thing that can nudge is a plan card, a destructive card, or an un-planned write the founder left sitting.
- **done** — `disarmSession()` on the founder's explicit disarm, AND the reaper on idle/ceiling expiry. `"God mode session <reason>. Re-arm in the app if needed."` No URL — the cockpit is dead.

**Not on plain replies.** A mid-turn assistant reply pushes NO SMS — the Chat tab handles live watching. The rule now: the 5-min approval nudge + done ONLY.

### Reaper — the poll-loop beat

`reapGodModeSessions(admin)` in [[../libraries/god-mode]]. Invoked from a `scripts/builder-worker.ts` beat every ~60s (throttled + in-flight-guarded, same shape as the stale-session-reaper next to it). One pass over all `armed` rows:

1. **Absolute ceiling first** — `now() > absolute_expires_at` (arm + 12h). Force-disarm regardless of activity. `status='expired'`, `cockpit_token=NULL`, `disarmed_at=now`. One session-done SMS with reason `"hit its 12h ceiling"`. The founder re-arms with one tap in the app.
2. **Idle ceiling** — `now() > token_expires_at`. But ONLY if there's NO in-flight signal:
   - `hasInFlight(sessionId)` — any `god_mode_approvals` row with `status='pending'`? A pending approval holds the door open indefinitely (the founder may sleep on the SMS).
   - A `queued`/`building`/`queued_resume` `agent_jobs` row with `kind='god-mode'` and `spec_slug=<session_id>`? A live turn holds the door open too.
   - Neither → idle-expire. Same terminal state as force-disarm, reason `"idled out"`.

Sliding-TTL renewal is orthogonal: every Phase-3 GET/message/approve + every Phase-4 GET/message/approve + every runGodModeJob turn calls `bumpActivity` (extends `token_expires_at` by `SLIDING_TTL_MS`). An actively-used session stays hot; the reaper only touches truly-idle ones.

**The same 60s beat also runs `nudgeStalePendingApprovals(admin)`** — the 5-min approval nudge (§ SMS above). It's a sibling of the reaper on the identical throttle/in-flight-guarded beat, so idle-expiry and the "you left an approval waiting" reminder share one loop.

**Why a poll beat, not an Inngest fn:** the box already has a 1-minute poll cadence for other reapers (the stale-session one); adding this beat is a 20-line diff. No new deploy target, no Inngest fn/dashboard page, no cross-boundary auth.

## Retirement (sunset)

Retire the whole feature (drop the two tables + the workspaces columns + delete `src/lib/god-mode.ts` + delete the routes + delete the box-worker lane + drop the reaper beat) once the CEO exec layer covers the incident remediation surface. Self-contained by construction — removal is a one-migration + one-PR cleanup.

## Phase 6 — Fix 1 — security regressions (injection + authz)

The pre-merge spec-test found two high-risk security findings in the Phase-2 permission gate:

1. **Command injection vulnerability** (`scripts/god-mode-permission-gate.ts:52-63` `isSafeBash()`): The allowlist check was loose — a command like `ls; rm -rf /tmp` would pass because the allowlist prefix `ls` appeared at the head. Fixed by: (1) tightening the prefix check to require exact match or match+space, (2) adding a shell-metacharacter rejection (`/[;&|`$<>\n]|\$\(/)`) after allowlist match, (3) belt-and-suspenders: force even allowlisted-prefix commands through the destructive rail if they match destructive patterns.

2. **Authorization bypass** (same location): The gate's loose prefix matching bypassed the founder-approval requirement that's the entire app-layer authorization for prod mutations under god-mode. Fixed by the same tightened checks above.

Both findings are now closed.

## Phase 7 — Fix 2 — scrypt memory limit regressions

The pre-merge spec-test found three failures in PIN handling (both setter + verifier):

1. **Phase 1 PIN setter crash** (`_set-god-mode-pin.ts`): `hashPin()` uses `scrypt(N=2^15, r=8, p=1)` which requires 128×(N+2)×r = 33.5 MB, exceeding Node's default maxmem (32 MB) by 2 KB. The setter crashed before writing any hash.

2. **Phase 3 PIN verify failure**: `verifyPin()` caught the same scrypt RangeError and returned `false`, blocking ALL destructive approvals regardless of the entered PIN (fail-closed, so safety intact — but unusable).

3. **Phase 4 PIN verify failure**: Same issue on the dashboard tab's destructive approve route.

Fixed by raising scrypt maxmem from 32 MB to 64 MB (or lowering SCRYPT_N; the fix chose maxmem to preserve security parameters). All three PIN paths now work.

## Status / open work

- Phase 1 (session model + arm/disarm + PIN): ✅ shipped.
- Phase 2 (full-power box lane + live permission gate): ✅ shipped.
- Phase 3 (SMS cockpit — token page with Chat + Approvals tabs): ✅ shipped.
- Phase 4 (in-app dashboard God Mode tab): ✅ shipped.
- Phase 5 (SMS delivery + lifecycle reaper): ✅ shipped.
- Phase 6 (Fix 1 — command injection + authz): ✅ shipped.
- Phase 7 (Fix 2 — scrypt memory limit): ✅ shipped.
