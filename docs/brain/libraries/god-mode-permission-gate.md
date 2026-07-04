# `scripts/god-mode-permission-gate.ts` — the box PreToolUse hook

The box-side permission gate that intercepts every tool call the god-mode `claude -p` session tries. Phase 2 of [[../specs/god-mode]]. See [[../lifecycles/god-mode]] · [[god-mode]] · [[../tables/god_mode_approvals]].

**North-star (supervisable autonomy):** god-mode is the founder's manual full-power supervisor bridge. THIS gate is what makes it a supervisor bridge and not a runaway proxy — every non-safe-read tool call blocks on the founder's approve/deny (or ask). The gate itself NEVER decides; it inserts an approval row and polls it. Only the founder's cockpit / dashboard tab writes the decision.

## Wiring

Injected into the `claude -p` invocation for `kind='god-mode'` by `scripts/builder-worker.ts` `runGodModeClaude` via inline `--settings` JSON:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": ".*", "hooks": [{ "type": "command", "command": "npx tsx <REPO>/scripts/god-mode-permission-gate.ts" }] }
    ]
  }
}
```

Plus `env.GOD_MODE_SESSION_ID=<uuid>` so the gate knows which session's approval queue to write. This is the FIRST place in ShopCX that spawns a `claude -p` without `--dangerously-skip-permissions`.

## Contract

- **stdin** — the Claude Code PreToolUse JSON payload: `{ session_id, tool_name, tool_input, ... }`.
- **stdout** — one JSON object: `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow"|"deny", permissionDecisionReason: "..." } }`.
- **exit** — always 0 (the decision is expressed via the JSON envelope; a non-zero exit would look like a hook crash to the CLI).

## Classification

Deterministic rails over `tool_name` + `tool_input`. Fail-safe on unknown tools (default to `needs_approval` with `risk='write'`).

### Safe (auto-allow — no row inserted)

- Tool names: `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `TodoWrite`, `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet`.
- Bash prefixes: `git status/diff/log/show/branch/ls-files/rev-parse/config --get/ls-remote/remote -v`, `ls`, `cat`, `pwd`, `wc`, `head`, `tail`, `find `, `which `, `printf`, `node -v`, `node --version`, `npm -v`, `npm --version`, `npx tsc --noEmit`, `npx tsc --version`, `grep `, `rg `, `gh pr list/view`, `gh issue list/view`, `gh run list/view`.
- Bash psql: only `psql -c 'SELECT …'` with no semicolon-separated second statement.

### Destructive (needs approval, risk='destructive' → Phase-3 PIN gate applies)

Regex rail (case-insensitive) over the command text:

- `rm -rf` / `rm -f -r` / `rmdir`
- `git push … --force` / `git push -f`, `git reset --hard`, `git clean -f`, `git branch -D`
- `DROP TABLE|DATABASE|SCHEMA|INDEX|COLUMN|POLICY|VIEW|FUNCTION`
- `TRUNCATE`, `DELETE FROM`, `ALTER TABLE … DROP`
- `supabase db reset|push`, `vercel … --prod|deploy --prod`
- `shutdown`

### Write (needs approval, risk='write')

Everything else non-safe — `Write`, `Edit`, `NotebookEdit`, and any Bash that isn't in the safe allowlist and isn't destructive.

False positives on the destructive rail are safe (harder to approve); false negatives are the real risk — extend the regex cautiously.

## Behavior on the row lifecycle

Poll every 2s. No hard cap on the poll loop — the outer god-mode session timeout (`GOD_MODE_TIMEOUT_MS` = 60min in the runner) is what kills a truly forgotten call.

- `pending` — continue polling. If the god-mode session flips out of `armed` while polling, exit `deny` (the founder disarmed while a tool was mid-flight).
- `approved` — `allow`.
- `denied` — `deny`.
- `asked` — `deny` with the founder's `question_text` embedded in `permissionDecisionReason`. The box reads it in the tool's reject-reason and can respond in-transcript, then re-request approval on the next tool call. Not a dead end.

## Fail-closed error handling

- Missing `GOD_MODE_SESSION_ID` env → `deny` (bug — the runner must set it).
- Malformed stdin → `deny`.
- Session not found or not armed → `deny`.
- Any thrown error → `deny` with the error message in the reason.

## Related

- [[god-mode]] — the SDK the gate calls into (`openApproval`, `getApproval`, `isSessionArmed`).
- [[../tables/god_mode_approvals]] — the row shape.
- [[../lifecycles/god-mode]] — end-to-end trace including the gate's role.
- [[../specs/god-mode]] — the spec this script implements (Phase 2).
