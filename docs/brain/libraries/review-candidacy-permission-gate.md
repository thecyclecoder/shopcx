# libraries/review-candidacy-permission-gate

Least-privilege PreToolUse permission gate for Sol's review-candidacy box session (review-request-sol-session Phase 4 § Fix 1).

**File:** `scripts/review-candidacy-permission-gate.ts`

## Why

The review-candidacy session reads **customer-controlled ticket messages INTO the prompt**. Without a per-tool gate the box-session fallback is `--dangerously-skip-permissions`. A malicious customer message could instruct the tool-enabled agent to read env / credentials / config files or run arbitrary shell — and `sandbox='max'` keeps production service-role secrets in `process.env`, so the blast radius is real.

This gate is the fix: a purpose-built least-privilege PreToolUse hook attached to `runReviewCandidacyClaude` via `permissionGate: { hookCommand: 'npx tsx scripts/review-candidacy-permission-gate.ts' }`. Only the surfaces Sol actually needs to reach her verdict are allowed; everything else denies with a named reason.

## Design

The gate is split cleanly:

- `decideReviewCandidacyPermission(toolName, toolInput, ticketId)` — the PURE decision function. Unit-tested in `src/lib/review-candidacy-permission-gate.test.ts` (19 tests covering every catastrophic-deny signal and every allowlist entry). Extracted so a regression that widens the gate fails LOUD.
- `main()` — the thin I/O shell: reads PreToolUse JSON on stdin, reads `REVIEW_CANDIDACY_TICKET_ID` from env, calls the pure fn, writes the `hookSpecificOutput.permissionDecision` on stdout, exits 0.

## Allow / Deny matrix

### Auto-allow (read-only)
- `Read`, `Grep`, `Glob`, `WebSearch`, `WebFetch`, `NotebookRead`, `TodoWrite`.
- `Bash` matching read-only shell built-ins: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `pwd`, `date`, `echo`, `git status|log|show|diff`.
- `Bash` matching exactly `npx tsx scripts/cx-agent-sdk-tool.ts <verb> <ticket_id>` or `npx tsx scripts/improve-box-tools.ts <tool> <ticket_id>` where `<ticket_id>` MATCHES the `REVIEW_CANDIDACY_TICKET_ID` env var. This ticket-binding stops a customer message from instructing "run against a DIFFERENT ticket" — a cross-ticket read is a hard deny.

### Hard deny (checked BEFORE the allowlist)
| Class | Examples |
|---|---|
| env inspection | `env`, `printenv`, `/proc/self/environ`, `$SECRET_VAR` expansion |
| credential/config file reads | `.env`, `~/.ssh`, `~/.aws`, `~/.claude`, `~/.config`, `~/.netrc` |
| network mutation | `curl -X POST\|PUT\|DELETE\|PATCH`, `curl -d/--data/-F/-T/--upload-file`, `wget --post-*`, `nc`, `ssh`, `scp` |
| git writes | `git push\|commit\|reset\|checkout\|add\|tag\|rebase\|merge\|cherry-pick\|rm\|clean\|apply\|am\|revert` |
| DB mutation | `psql`, `supabase db\|migration\|functions` |
| catastrophic FS | `rm -rf`, `chmod`, `chown`, `mv to /` |
| shell wrappers | `bash -c`, `sh -c`, `eval`, `exec`, `\| bash` |
| chained commands | any `;` / `&` / `\|` in the Bash payload |

### Write tools (blanket deny)
`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Task`, `Agent`, `ExitPlanMode`.

### Unknown / MCP tool
**Deny by default** (allowlist, not blocklist). A novel tool must be added here explicitly before it can reach the gate.

## Two additional guards in the runner

The permission gate is the runtime chokepoint. The runner (`scripts/builder-worker.ts` `runReviewCandidacyJob`) also carries two upstream guards:

1. **Workspace/customer validation BEFORE the launch.** Before `loadTicketHandleBrief`, the runner fetches `tickets.id/workspace_id/customer_id` for the claimed `ticket_id` and refuses to launch when `ticket.workspace_id !== job.workspace_id` or `ticket.customer_id !== params.customer_id`. A rogue detector / spec-authored agent_jobs row can't cause the box to load a foreign workspace's data.
2. **Sanitized error persistence.** On an unparseable verdict, the runner writes a BOUNDED sanitized error to `log_tail` (`"review-candidacy: session <sid> produced no parseable verdict (raw output withheld — see security note)"`) — NOT the raw session transcript. The raw output can carry tool responses that include secrets the gate caught mid-attempt; persisting it back to `agent_jobs.log_tail` would be the second half of the exfiltration path.

## Related

- **Runner** — `scripts/builder-worker.ts` `runReviewCandidacyClaude` + `runReviewCandidacyJob`.
- **Cron** — [[../inngest/review-candidacy-detector-cron]].
- **Similar gate** — `scripts/god-mode-permission-gate.ts` (the god-mode lane's own, differently-scoped gate).
- **Skill** — `.claude/skills/review-candidacy/SKILL.md` — Sol's read-only decision skill this gate enforces.

---

[[../README]] · [[../../CLAUDE]]
