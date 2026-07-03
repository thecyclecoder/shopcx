# Recipe: Founder Pulse — local session capture

The wiring on the **founder's Mac** that feeds the Pulse. It is the one piece of the `founder-pulse` feature that lives *outside* the repo/box, because the deployed app and the [[build-box-setup|build box]] **cannot reach the founder's filesystem** — the raw Claude session transcripts only exist locally, so the digest has to be *pushed* from the machine they live on.

Tracking: the feature itself is the **`founder-pulse` spec** (a row in `public.specs` — see [[../project-management]] for how in-flight specs are tracked; there is no `specs/*.md`). This page documents only the already-installed local capture wiring.

## The digest chain

```
~/.claude/projects/-Users-admin-Projects-shopcx/*.jsonl   (raw transcripts, LOCAL only)
        │  scripts/pulse-digest.ts  — distills human turns + terminal actions (spec/commit),
        │                             NOT the ~10MB of tool payload; LLM → structured digest
        ▼
public.pulse_session_digests   (Supabase — distilled rows only; raw transcripts never leave the Mac)
        ▼
/dashboard/developer/pulse      (the deployed page just READS the DB)
```

## The two triggers — both installed, both guarded

Both run the same guarded command, so nothing happens until the script exists:
`[ -f scripts/pulse-digest.ts ] && /opt/homebrew/bin/npx tsx scripts/pulse-digest.ts >> /tmp/pulse-digest.log 2>&1`

1. **launchd timer** — `~/Library/LaunchAgents/ai.shopcx.pulse-digest.plist`, `StartInterval` 900s (15 min). **The base coverage: idle-safe *and* hard-close-safe**, because it watches the transcript files' mtimes, not keystrokes. Closing the terminal, killing the window, or walking away from an open session are all caught within ≤15 min.
2. **SessionEnd hook** — in `.claude/settings.local.json` (gitignored → **stays off the box**, fires only for this project on the founder's Mac). Fires *instantly* on a graceful `/exit` / Ctrl-D. NOT guaranteed on a hard window-close (SIGHUP) — that's what the timer backstops.

**Path contract (important for the P1 build):** both triggers are already wired to `scripts/pulse-digest.ts`. Building the digest script at exactly that path **auto-activates** capture — the build must **NOT** author its own hook/timer; they exist.

- **Timezone:** session timestamps are UTC; the digest normalizes display to **America/Puerto_Rico (AST, no DST)** — the founder's wall clock.
- **Logs:** `/tmp/pulse-digest.log` (run output), `/tmp/pulse-digest.out.log`, `/tmp/pulse-digest.err.log`.

## Verify it's live

```bash
launchctl list | grep pulse-digest                                  # registered?
launchctl print gui/$(id -u)/ai.shopcx.pulse-digest | grep state    # active?
```

## Disable / uninstall (local machine)

**Fastest kill-switch — no config edits:** both triggers are guarded on the script's existence, so **deleting or renaming `scripts/pulse-digest.ts` instantly no-ops both.**

**Pause the timer** (keep it installed):
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.shopcx.pulse-digest.plist
```
Re-enable:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.shopcx.pulse-digest.plist
```

**Remove the timer entirely:**
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.shopcx.pulse-digest.plist 2>/dev/null
rm ~/Library/LaunchAgents/ai.shopcx.pulse-digest.plist
```

**Remove the SessionEnd hook:** delete the `hooks.SessionEnd` entry whose `command` contains `pulse-digest.ts` from `.claude/settings.local.json` (leave the `permissions` block untouched).

**Confirm gone:** `launchctl list | grep pulse-digest` returns nothing, and no `pulse-digest` command remains in `.claude/settings.local.json`.

## Status / where the rest lives

The digest script, the `pulse_session_digests` + `pulse_snapshots` tables, `src/lib/pulse.ts`, and the `/dashboard/developer/pulse` page are built by the `founder-pulse` spec's phases (P1–P3); each lands its own [[../tables]] / [[../libraries]] brain page in-PR (CLAUDE.md rule) and folds into a Pulse lifecycle page on ship. This capture-wiring page is the durable operational record of the local half that the pipeline can't build for you.
