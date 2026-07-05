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
- The **plan primitive**: `npx tsx [path/]scripts/god-mode-plan.ts (open|close|status) …` (anchored `PLAN_CMD_RE`). Auto-allowed so invoking it never itself lands a card — its whole job is to raise the ONE plan card and poll it internally. Still subject to the shell-metachar guard, so a title carrying `$(…)`/backtick can't smuggle a subshell past the allowlist.
- Bash whole-command rules: (1) the whole command must be `prefix` alone OR start with `prefix ` (space required — a loose `startsWith(prefix)` was the old bypass vector); (2) the command must contain NO shell metacharacters — `;`, `&`, `|`, `` ` ``, `$`, `<`, `>`, `\n`, or `$(` fail-close the check. `ls; rm -rf /tmp`, `ls && cat /etc/passwd`, and `cat "$(curl attacker)"` all reject.
- Destructive-rail override: a command that matches the destructive rail (`rm -rf`, `git branch -D`, `git reset --hard`, `DROP TABLE`, `TRUNCATE`, `supabase db reset`, `vercel … --prod`, etc.) is ALWAYS routed to `needs_approval` `risk='destructive'` — even if a prefix in the allowlist would otherwise cover it. Belt-and-suspenders against a novel destructive shape that slips into an allowlisted prefix.

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

## Plan-scoped approvals — approve the DECISION, not every keystroke

The pain this fixes: the gate classifies PER tool call, so one logical decision (e.g. "dismiss 4 stale approvals" — investigate, then one surgical write) fanned out into ~9 separate cards (write probe → run → write probe → run → write fix → run → verify). The founder was rubber-stamping mechanics.

A **plan** is a plain-language UNIT OF WORK the founder approves ONCE. Mechanism:

1. The box does read-only investigation (auto-allowed — `Read`/`Grep`/`psql -c SELECT`).
2. It opens a plan: `npx tsx scripts/god-mode-plan.ts open "<decision>" "step 1" "step 2"`. That script ([[god-mode]] `openPlan`) inserts ONE `god_mode_approvals` row `risk='plan'`, `tool_name='Plan'`, `preview`=the decision+steps, and polls it exactly like the gate polls a tool call. The founder sees a single **Plan** card and approves it.
3. On approval the script sets [[../tables/god_mode_sessions]].`active_plan_id` → the plan row.
4. **This gate**, on every subsequent non-safe call, calls [[god-mode]] `getActivePlan(sessionId)`: if the session has an approved open plan (`active_plan_id` set AND that row is `status='approved'` + `risk='plan'`) **and the call is NOT destructive**, it AUTO-ALLOWS (`permissionDecisionReason` names the plan id) — no new card. The plan-scoped block sits right after the safe-allow branch, before `openApproval`.

**Destructive calls NEVER batch under a plan.** The `cls.risk !== "destructive"` guard means DROP/TRUNCATE/DELETE/force-push/`vercel --prod`/`rm -rf` fall through to the normal `openApproval` + PIN gate even while a plan is open — the irreversible always individually counter-signed. Supervisability holds: the Chat tab streams every auto-allowed call live and disarm tears the session down mid-flight.

**A plan authorizes work only within the turn it was approved in.** `runGodModeJob` clears `active_plan_id` at the start of every turn, and `god-mode-plan.ts close` clears it explicitly — so a new founder message never inherits a stale open plan. No open plan ⇒ the gate behaves exactly as pre-hotfix (per-call gating), so the change is fully backward-compatible.

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

## CEO-grade rewrite (2026-07) — allow-by-default + catastrophic floor

The gate was rewritten from per-tool-call classification (safe/write/destructive) to a THIN DETERMINISTIC FLOOR. It now ALLOWS everything — writes, edits, scripts, database queries, ordinary shell, git, PRs, MCP/unknown tools — and gates exactly ONE thing: a **Bash command on the catastrophic rail** (`rm -rf`, `DROP TABLE/DATABASE/…`, `TRUNCATE`, `DELETE FROM` with NO `WHERE`, `git push --force`, `supabase db reset`), which lands a `risk='destructive'` card with a plain-language headline and requires the founder's PIN. Writing a script is always free (even destructive contents) — approval attaches to EXECUTING something catastrophic. The plan-scoped `getActivePlan` auto-allow was removed (non-destructive work now allows unconditionally). Routing genuine CEO-grade decisions is the BOX's job (`scripts/god-mode-plan.ts decide`), not the gate's. See [[../lifecycles/god-mode]] § CEO-grade approval model.
