# Box multi-account round-robin + failover — survive (and outrun) the Max usage wall ⏳

> **Do not build until 4:15pm PR time (owner hold, 2026-06-22)** — the box account just reset; let it stabilize first.

**Owner:** [[../functions/platform]] · **Parent:** extends the box build pipeline (`scripts/builder-worker.ts`). · **Found in use 2026-06-22:** the owner hit the Max 5-hour usage wall in ~3h; the box (same Max account) capped too → **12 builds failed at once**, and nothing could build until the reset (~4pm). The owner now has a **second Claude account** and proposed swapping between them via `CLAUDE_CONFIG_DIR`.

`CLAUDE_CONFIG_DIR` points the `claude` CLI at an isolated credentials/config dir — so two accounts coexist on the box (`~/.claude` + `~/.claude-personal`, each logged in once). A shell **alias** (`claude2`) is fine for *manual* runs, but **the worker spawns `claude` directly** (`spawn`, not an interactive shell — `builder-worker.ts:246`), so an alias never reaches it. The worker must select the config dir in its **env object** itself, and — the real win — **fail over automatically** when an account hits the wall.

## Model — round-robin across accounts (failover as the backstop)
- **Account pool:** a list of `CLAUDE_CONFIG_DIR`s the box can use (e.g. `["/home/builder/.claude", "/home/builder/.claude-personal"]`). Configurable (env/const), each logged in once on the box.
- **Round-robin assignment (the main win — proactive, not reactive):** each new build/lane is assigned the **least-recently-used (or round-robin) account** in the pool at claim time, **spreading load across both accounts** so each does ~half the work. Effect: ~**2× sustained throughput** AND each account hits its 5-hour wall ~2× slower — instead of burning account #1 to the wall and only *then* switching. The worker sets the chosen `CLAUDE_CONFIG_DIR` in the `env` it already builds (`builder-worker.ts:237`). (`ANTHROPIC_API_KEY` stays unset — still Max, never per-token.)
- **Cap removes an account from rotation (failover backstop):** detect a usage-wall failure from the `claude -p` result/stderr (usage-limit / quota / "limit reached" — distinct from a 529/overloaded transient, which is the existing retry). A capped account is **pulled from the round-robin** (with a reset-time estimate) until it recovers; remaining work concentrates on the still-healthy account(s). If ALL accounts are capped → mark the job `blocked_on_usage` (NOT a hard fail — auto-resumes, never a manual rebuild) and back off until the soonest reset.
- **Cross-account sessions DON'T resume — pin the resume to its account (learned + proven 2026-06-22):** a `claude --resume <session-id>` only works under the **same** config dir that created it — switching accounts mid-job orphaned every session ("No conversation found with session ID"; we hit this on all 7 resumable jobs when the box moved to account #2). Non-negotiable rules:
  - **Persist the owning account with the session.** Store the config dir that created a session alongside `claude_session_id` (a new `claude_session_config_dir` field, or equivalent) at the moment the session is recorded. Without this the box can't know which account to resume under.
  - **Round-robin picks an account for a NEW session only** (first dispatch / fresh build). It must **never** reassign the account of a job that already has a session.
  - **A resume is PINNED to its session's owning account** — the worker sets `CLAUDE_CONFIG_DIR` to the stored dir, overriding round-robin. It does NOT try the resume under any other account (that's the guaranteed "No conversation found" failure).
  - **If the owning account is capped:** do NOT attempt a cross-account resume. Either wait for that account (if the job can tolerate it) or **start fresh** — clear `claude_session_id` + its stored config dir and re-dispatch as a new session on a healthy account (idempotent: a build re-reads the spec; a resume's progress is sacrificed but the job completes rather than hard-failing).
- **Manual escape hatch (the owner's original idea):** the `claude2` alias + the `~/.claude-personal` login, documented in the box recipe, for ad-hoc manual runs / debugging.
- **Surface it (north star):** per-account in-flight load + active accounts + any cap/failover event + an all-accounts-capped state go to the Control Tower (box-health), so a silent "everything's capped" is visible and the owner sees how each account's quota is burning.

## Verification
- With both accounts healthy, **consecutive builds alternate accounts** (round-robin / least-recently-used) — load splits ~50/50 across the pool, not all on one.
- Account #1 capped → it's **pulled from rotation**; new builds go to account #2 and complete — no manual swap, no failed row; #1 rejoins after its reset.
- Both capped → jobs go `blocked_on_usage` (not `failed`) and **auto-resume when an account resets** (no manual re-queue / rebuild).
- A resume runs **under its session's owning account** (the stored config dir), regardless of whose turn round-robin would pick — never a cross-account `--resume`, never a "No conversation found" failure.
- A resume whose owning account is capped → **starts fresh** on a healthy account (clears `claude_session_id` + stored dir), not a hard fail.
- A NEW session records its owning account; a later resume of it reads that account back and pins to it.
- A normal 529/overloaded transient still uses the existing retry (NOT treated as a cap / account switch).
- `claude2` alias + `~/.claude-personal` login work for a manual `claude2 -p` on the box.
- The Control Tower shows per-account load + surfaces an all-capped state; a cap/failover event is logged.
- Negative: with one healthy account, builds run normally on it (no spurious switching / no false cap).

## Phase 1 — round-robin assignment + usage-cap rotation + session pinning in the worker ⏳
Account pool + least-recently-used/round-robin `CLAUDE_CONFIG_DIR` selection **for new sessions only**; **persist the session's owning config dir** (`claude_session_config_dir`) and **pin every resume to it** (never cross-account `--resume`); usage-cap detection (vs 529-transient) pulls an account from rotation; a resume whose account is capped starts fresh (clear session + stored dir); `blocked_on_usage` auto-resuming state when all capped. Brain: [[../recipes/build-the-box]] (if present) · [[../operational-rules]] · [[control-tower]].

## Phase 2 — second-account setup + Control Tower surfacing ⏳
Document/perform the `~/.claude-personal` login + `claude2` alias on the box; surface active-account + all-capped + failover events to the Control Tower box-health. Brain: [[../libraries/control-tower]] · [[../recipes/build-the-box]].
