# Recipe: Mac usage reporter (fleet-usage-cockpit Phase 2)

The wiring on the **founder's Mac** that feeds the Max/Codex sides of the [[../dashboard/developer__usage|/dashboard/developer/usage]] cockpit. Like [[founder-pulse-capture]], it lives *outside* the repo/box because the deployed app and the [[build-box-setup|build box]] **cannot reach the founder's filesystem** — the raw Claude/Codex session logs only exist locally, so the rollup has to be *pushed* from the machine they live on.

Tracking: the feature itself is the **`fleet-usage-cockpit` spec** (a row in `public.specs` — see [[../project-management]]). This page documents only the already-installable local reporter wiring.

## The reporter chain

```
~/.claude                      ~/.codex/sessions
   │                                │
   └──── ccusage blocks --json ─────┘        (LOCAL only — the box can't see these)
                     │
                     ▼
    scripts/usage-report.ts            (pure map via mapCcusageToSnapshots +
                     │                  POST driver — no admin key on the wire)
                     ▼
    POST /api/developer/usage/report   (owner-gated bearer token; upserts
                     │                  account_usage_snapshots with source='mac')
                     ▼
    public.account_usage_snapshots     (unique key REPLACES the prior Mac slice)
                     ▼
    /dashboard/developer/usage         (Phase 3 — cockpit reads box+mac SUM)
```

`scripts/usage-report.ts` is pure at heart — the [[../libraries/usage-snapshots]] `mapCcusageToSnapshots` mapper turns each ccusage output into ONE `'5h'` + ONE `'weekly'` snapshot per account. The script POSTs the batch to the deployed endpoint with an owner bearer token — the reporter never carries the service-role key.

## Path + token contract

Everything the reporter needs is a local env — nothing lives on the box.

| env var | required | purpose |
|---|---|---|
| `USAGE_REPORT_TOKEN` | ✅ | The pre-shared owner token. **Server-side** the same value is set on Vercel as `DEVELOPER_USAGE_INGEST_TOKEN`. `POST` returns `401` if the header is missing / `403` on a token mismatch (constant-time compare). |
| `USAGE_REPORT_URL` | default `https://shopcx.ai/api/developer/usage/report` | The deployed endpoint. |
| `USAGE_REPORT_WORKSPACE_ID` | default `fdc11e10-b89f-4989-8b73-ed6526c4d906` | The workspace the snapshots UPSERT into (RLS scope). |
| `USAGE_REPORT_CLAUDE_ACCOUNT` | default `Round Robin 1` | Label the Mac's Claude output is attributed to. Any label the box also uses (`'Round Robin 1'..'Round Robin 4'`) works. |
| `USAGE_REPORT_CODEX_ACCOUNT` | default `codex` | Label the Mac's Codex output is attributed to. Must match [[../tables/account_usage_snapshots]].`account`. |
| `USAGE_REPORT_CLAUDE_HOME` | optional | Passes `CLAUDE_CONFIG_DIR=<this>` into the Claude ccusage call — useful when the Mac runs multiple Claude accounts. |
| `USAGE_REPORT_CODEX_HOME` | optional | Passes `CODEX_HOME=<this>` into the Codex ccusage call. |

Put them in `~/.zshrc` (or the Mac's `.env.local` next to [[founder-pulse-capture|pulse-digest]]) — **never committed**.

## The two triggers — same shape as [[founder-pulse-capture]]

Both run the same guarded command, so nothing happens until the script exists:
`[ -f scripts/usage-report.ts ] && /opt/homebrew/bin/npx tsx scripts/usage-report.ts >> /tmp/usage-report.log 2>&1`

1. **launchd timer** — `~/Library/LaunchAgents/ai.shopcx.usage-report.plist`, `StartInterval` 900s (15 min). The base coverage — a rolling 5h window changes fast enough that 15-min freshness is enough for the cockpit; a longer interval would leave stale rate-limit-proximity readings.
2. **SessionEnd hook** *(optional)* — in `.claude/settings.local.json` (gitignored → **stays off the box**). Fires instantly on a graceful `/exit` / Ctrl-D so a session's final burn lands in the cockpit before the timer's next tick.

**Path contract:** both triggers point at `scripts/usage-report.ts`. Building the script at exactly that path **auto-activates** the reporter — the build must **NOT** author its own plist/hook.

- **Timezone:** ccusage outputs UTC; the cockpit renders in AST (America/Puerto_Rico, no DST) via the same helper [[../libraries/pulse-digest]] uses.
- **Logs:** `/tmp/usage-report.log` (run output), `/tmp/usage-report.out.log`, `/tmp/usage-report.err.log`.

## Install

1. Set the env vars (at least `USAGE_REPORT_TOKEN`) in `~/.zshrc` / your Mac's local env.
2. Ship the token to Vercel: `DEVELOPER_USAGE_INGEST_TOKEN` on the deployed environment (never checked in).
3. Test manually: `npx tsx scripts/usage-report.ts` — expected output ends with `[usage-report] upserted=<N>`.
4. Install the timer plist:

```xml
<!-- ~/Library/LaunchAgents/ai.shopcx.usage-report.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>ai.shopcx.usage-report</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string><string>-lc</string>
      <string>cd ~/Projects/shopcx && [ -f scripts/usage-report.ts ] && /opt/homebrew/bin/npx tsx scripts/usage-report.ts >> /tmp/usage-report.log 2>&1</string>
    </array>
    <key>StartInterval</key><integer>900</integer>
    <key>StandardOutPath</key><string>/tmp/usage-report.out.log</string>
    <key>StandardErrorPath</key><string>/tmp/usage-report.err.log</string>
    <key>RunAtLoad</key><true/>
  </dict>
</plist>
```

5. Bootstrap it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.shopcx.usage-report.plist`.

## Verify it's live

```bash
launchctl list | grep usage-report                                     # registered?
launchctl print gui/$(id -u)/ai.shopcx.usage-report | grep state       # active?
tail -f /tmp/usage-report.log                                          # last run
```

Then check the DB: [[../tables/account_usage_snapshots]] should carry `source='mac'` rows for `Round Robin 1` (or your `USAGE_REPORT_CLAUDE_ACCOUNT`) + `codex`, one `'5h'` + one `'weekly'` each.

## Disable / uninstall (local machine)

**Fastest kill-switch — no config edits:** the timer is guarded on the script's existence, so **deleting or renaming `scripts/usage-report.ts` instantly no-ops both.**

**Pause the timer** (keep it installed):
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.shopcx.usage-report.plist
```
Re-enable:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.shopcx.usage-report.plist
```

**Remove the timer entirely:**
```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.shopcx.usage-report.plist 2>/dev/null
rm ~/Library/LaunchAgents/ai.shopcx.usage-report.plist
```

**Remove the SessionEnd hook (if you added one):** delete the `hooks.SessionEnd` entry whose `command` contains `usage-report.ts` from `.claude/settings.local.json` (leave the `permissions` block untouched).

**Server-side kill-switch:** unset `DEVELOPER_USAGE_INGEST_TOKEN` on Vercel — the route returns `401` on every POST and no snapshots land.

**Confirm gone:** `launchctl list | grep usage-report` returns nothing.

## Status / where the rest lives

- Phase 1 (already merged): the box's `rollupBoxAccountUsage` writes `source='box'` snapshots; wall events are recorded on cap detection so `discoverLimit(account, window_kind)` converges toward the true hidden Max limit. See [[../libraries/usage-snapshots]] + [[../tables/usage_wall_events]].
- Phase 2 (this page): the Mac reporter route + script + these local triggers.
- Phase 3 (upcoming): the `/dashboard/developer/usage` cockpit page that sums box+mac per account.

## Related

[[founder-pulse-capture]] · [[build-box-setup]] · [[../tables/account_usage_snapshots]] · [[../tables/usage_wall_events]] · [[../libraries/usage-snapshots]] · [[../specs/fleet-usage-cockpit]] · [[../functions/platform]]
