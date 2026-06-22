# Box multi-account failover — survive the Max usage wall ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends the box build pipeline (`scripts/builder-worker.ts`). · **Found in use 2026-06-22:** the owner hit the Max 5-hour usage wall in ~3h; the box (same Max account) capped too → **12 builds failed at once**, and nothing could build until the reset (~4pm). The owner now has a **second Claude account** and proposed swapping between them via `CLAUDE_CONFIG_DIR`.

`CLAUDE_CONFIG_DIR` points the `claude` CLI at an isolated credentials/config dir — so two accounts coexist on the box (`~/.claude` + `~/.claude-personal`, each logged in once). A shell **alias** (`claude2`) is fine for *manual* runs, but **the worker spawns `claude` directly** (`spawn`, not an interactive shell — `builder-worker.ts:246`), so an alias never reaches it. The worker must select the config dir in its **env object** itself, and — the real win — **fail over automatically** when an account hits the wall.

## Model
- **Account pool:** an ordered list of `CLAUDE_CONFIG_DIR`s the box can use (e.g. `["", "/home/builder/.claude-personal"]` — `""` = the default `~/.claude`). Configurable (env/const), each logged in once on the box.
- **Per-build selection:** the worker sets `CLAUDE_CONFIG_DIR` in the `env` it already builds (`builder-worker.ts:237`) to the **currently-active** account. (`ANTHROPIC_API_KEY` stays unset — still Max, never per-token.)
- **Auto-failover on usage-cap:** detect a usage-wall failure from the `claude -p` result/stderr (the usage-limit / quota / "limit reached" signal — distinct from a 529/overloaded transient, which is the existing retry). On a cap: **advance to the next account in the pool and retry the build** on it. If ALL accounts are capped → mark the job a distinct `blocked_on_usage` (NOT a hard fail — it should auto-resume, not need a manual rebuild) and back off until reset.
- **Manual escape hatch (the owner's original idea):** also set up the `claude2` alias + the `~/.claude-personal` login on the box, documented in the box recipe, for ad-hoc manual runs / debugging.
- **Surface it (north star):** the active account + any failover event + an all-accounts-capped state go to the Control Tower (a box-health signal), so a silent "everything's capped" is visible, and the owner knows which account is burning.

## Verification
- With account #1 capped (or simulated cap signal), a build **auto-fails over** to account #2's `CLAUDE_CONFIG_DIR` and completes — no manual swap, no failed row.
- Both accounts capped → jobs go `blocked_on_usage` (not `failed`) and **auto-resume when an account resets** (no manual re-queue / rebuild).
- A normal 529/overloaded transient still uses the existing retry (NOT treated as a cap / account switch).
- `claude2` alias + `~/.claude-personal` login work for a manual `claude2 -p` on the box.
- The Control Tower shows the active account + surfaces an all-capped state; a failover event is logged.
- Negative: with one healthy account, builds run normally on it (no spurious switching).

## Phase 1 — config-dir selection + usage-cap auto-failover in the worker ⏳
Account pool + `CLAUDE_CONFIG_DIR` in the build env; usage-cap detection (vs 529-transient) → advance + retry; `blocked_on_usage` auto-resuming state when all capped. Brain: [[../recipes/build-the-box]] (if present) · [[../operational-rules]] · [[control-tower]].

## Phase 2 — second-account setup + Control Tower surfacing ⏳
Document/perform the `~/.claude-personal` login + `claude2` alias on the box; surface active-account + all-capped + failover events to the Control Tower box-health. Brain: [[../libraries/control-tower]] · [[../recipes/build-the-box]].
