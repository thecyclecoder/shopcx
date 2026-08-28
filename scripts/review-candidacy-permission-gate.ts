/**
 * review-candidacy-permission-gate — the box-side PreToolUse hook for Sol's
 * review-candidacy lane (review-request-sol-session Phase 4 § Fix 1, tightened
 * in Phase 5 § Fix 2 to path-validate Read / NotebookRead).
 *
 * WHY THIS EXISTS
 * ---------------
 * The review-candidacy session reads customer-controlled ticket messages
 * INTO the prompt. Without a per-tool gate, the box-session fallback is
 * `--dangerously-skip-permissions` — a malicious customer message could
 * instruct the tool-enabled agent to read env / credentials / config files
 * or run arbitrary shell. `sandbox='max'` keeps production service-role
 * secrets in `process.env`, so the blast radius is real.
 *
 * The FIX is a purpose-built least-privilege gate. Only the surfaces Sol
 * actually needs to reach her verdict — repo-scoped file reads, the two
 * read-only CX SDK CLIs bound to the CLAIMED ticket id, WebSearch — are
 * allowed. Everything else denies with a named reason.
 *
 * Contract (Claude Code hooks): stdin = PreToolUse JSON
 * `{tool_name, tool_input}`; env `REVIEW_CANDIDACY_TICKET_ID` (the claimed
 * ticket id, set by the runner); stdout =
 * `{hookSpecificOutput:{permissionDecision}}`; exit 0.
 *
 * PURE DECISION KEPT SEPARATE FROM I/O
 * ------------------------------------
 * The catch-and-return decision fn is `decideReviewCandidacyPermission`,
 * pure, unit-testable in isolation — the invariant a spec-test can pin
 * without spawning the hook. `main()` is the thin I/O shell that reads
 * stdin, calls the pure fn, writes stdout, exits.
 */
import * as path from "node:path";

/** The tool decision the gate emits to claude-code. */
export type ReviewCandidacyPermissionDecision =
  | { decision: "allow"; reason: string }
  | { decision: "deny"; reason: string };

/**
 * Absolute deny patterns — checked BEFORE the allowlist so a `Bash` call
 * that happens to contain a phony `improve-box-tools.ts` reference but
 * ALSO tries to exfiltrate env can never sneak through.
 *
 * Kept intentionally conservative (over-block rather than under-block).
 * Every regex names the risk the block covers.
 */
const CATASTROPHIC_BASH_DENY: readonly { re: RegExp; risk: string }[] = [
  // env inspection — printenv, env, echo $SECRET_VAR, /proc/*/environ, dumping secrets
  { re: /\b(printenv|env)\b(\s|$)/i, risk: "env inspection" },
  { re: /\$(\{[^}]*\}|[A-Z_][A-Z0-9_]*)\b/, risk: "env variable expansion" },
  { re: /\/proc\/(self|\d+)\/environ/i, risk: "reading /proc environ" },
  { re: /\/proc\/(self|\d+)\/cmdline/i, risk: "reading /proc cmdline" },
  // credential + config file reads — trailing slash is OPTIONAL so `ls ~/.aws`
  // (no trailing slash) also denies, not just `ls ~/.aws/credentials`.
  { re: /\.env(\.[a-z0-9-]+)?\b/i, risk: "reading a .env file" },
  { re: /(^|[\s/~])\.ssh(\/|\b)/i, risk: "reading ~/.ssh" },
  { re: /(^|[\s/~])\.aws(\/|\b)/i, risk: "reading ~/.aws" },
  { re: /(^|[\s/~])\.claude(\/|\b)/i, risk: "reading ~/.claude" },
  { re: /(^|[\s/~])\.config(\/|\b)/i, risk: "reading ~/.config" },
  { re: /(^|[\s/~])\.netrc\b/i, risk: "reading ~/.netrc" },
  // network mutation — POST/PUT/DELETE/PATCH via curl/wget, uploading files, ssh out
  { re: /\bcurl\b[^\n]*\s-X\s*(POST|PUT|DELETE|PATCH)/i, risk: "curl mutation verb" },
  { re: /\bcurl\b[^\n]*\s(-d\b|--data\b|-F\b|--form\b|-T\b|--upload-file\b)/i, risk: "curl payload upload" },
  { re: /\bwget\b[^\n]*\s(--post-data\b|--post-file\b)/i, risk: "wget POST" },
  { re: /\b(nc|ncat|netcat)\b/i, risk: "netcat / nc" },
  { re: /\bssh\b(\s|$)/i, risk: "ssh outbound" },
  { re: /\bscp\b(\s|$)/i, risk: "scp outbound" },
  // git writes — the box is read-only for this lane; a customer message
  // could instruct git push / commit / reset / checkout / add / tag.
  {
    re: /\bgit\s+(push|commit|reset|checkout|add|tag|rebase|merge|cherry-pick|rm\b|clean\b|apply\b|am\b|revert)\b/i,
    risk: "git write",
  },
  // arbitrary DB mutation via psql / raw SQL — never Sol's job here.
  { re: /\bpsql\b/i, risk: "psql direct" },
  // supabase CLI mutations — reset, migration up, db push, etc.
  { re: /\bsupabase\s+(db|migration|functions)\b/i, risk: "supabase CLI mutation" },
  // catastrophic filesystem
  { re: /\brm\s+-[rf]*(r[rf]*f|f[rf]*r)[rf]*\b/i, risk: "rm -rf" },
  { re: /\bmv\s+.*\s+\/\b/i, risk: "mv to root" },
  { re: /\bchmod\b/i, risk: "chmod" },
  { re: /\bchown\b/i, risk: "chown" },
  // exec/spawn wrappers that would defeat pattern matching
  { re: /\b(bash|sh|zsh|dash)\s+-c\b/i, risk: "shell -c wrapper" },
  { re: /\beval\b/i, risk: "eval" },
  { re: /\bexec\b/i, risk: "exec" },
  { re: /\|\s*(bash|sh|zsh|dash)\b/i, risk: "pipe to shell" },
];

/**
 * The Bash commands Sol ACTUALLY needs — the two read-only CX SDK CLIs
 * bound to the CLAIMED ticket id. The regex requires the ticket id token
 * to appear in the command line, so a customer message that instructs "run
 * this against a different ticket" can't reach that ticket's data.
 *
 * A bounded set of read-only shell built-ins (`ls`, `cat`, `head`, `tail`,
 * `wc`, `grep`, `git status`, `git log`, `git show`, `git diff`, `pwd`,
 * `date`, `echo`) is allowed for basic introspection — none can mutate.
 */
function isAllowedBashCommand(command: string, ticketId: string | null): boolean {
  const cmd = command.trim();
  if (!cmd) return false;

  // Read-only CX SDK / improve-box-tools CLIs bound to the claimed ticket id.
  if (ticketId) {
    const boundToTicket = (script: string) => {
      const re = new RegExp(
        String.raw`^npx\s+tsx\s+scripts/${script}(\s+[^\s]+)?\s+${escapeRegex(ticketId)}(\s|$)`,
      );
      return re.test(cmd);
    };
    if (boundToTicket("cx-agent-sdk-tool\\.ts")) return true;
    if (boundToTicket("improve-box-tools\\.ts")) return true;
  }

  // Read-only shell built-ins Sol may use for basic navigation. Kept
  // narrow — a single command per line, no `&&` / `;` chains (those
  // route through Bash's chain parser, which the catastrophic-deny above
  // treats as `bash -c` in practice; but we also refuse them here).
  if (/[;&|]/.test(cmd)) return false;
  const safeHead = /^(ls|cat|head|tail|wc|grep|pwd|date|echo|git\s+(status|log|show|diff))(\s|$)/;
  if (safeHead.test(cmd)) return true;

  return false;
}

/** Escape a string for use inside a regex literal (dot, dashes, etc.). */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Credential/config directory segments — denied regardless of whether the
 * customer message routes them via Bash or Read/NotebookRead. Repo-relative
 * paths that traverse into `~/.ssh`, `~/.aws`, `~/.claude`, `.config`, etc.
 * still land here after resolution.
 */
const CATASTROPHIC_PATH_SEGMENTS = new Set<string>([
  ".ssh",
  ".aws",
  ".claude",
  ".config",
  ".netrc",
  ".gnupg",
  ".pgpass",
]);

/** Any `.env` / `.env.<suffix>` filename, case-insensitive. */
const DOT_ENV_FILENAME = /^\.env(\.[a-z0-9-]+)?$/i;

/**
 * Repo-safe path check for Read / NotebookRead — resolves the raw path
 * against `repoRoot`, then rejects anything that (a) escapes the repo,
 * (b) mentions a `.env` file at any depth, or (c) touches a credential /
 * config directory anywhere along its resolved path.
 *
 * Pure. `repoRoot` is caller-supplied so tests can pin a fake repo.
 */
export function isRepoScopedReadPath(
  rawPath: unknown,
  repoRoot: string,
): { ok: true } | { ok: false; risk: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, risk: "empty path" };
  }
  const trimmed = rawPath.trim();

  // Env variable expansion in a path — never legitimate here, and it
  // would let the agent lazily reach `$HOME/.aws/credentials` past the
  // resolver.
  if (/\$(\{[^}]*\}|[A-Z_][A-Z0-9_]*)/.test(trimmed)) {
    return { ok: false, risk: "env variable expansion in path" };
  }

  // Home-relative `~` never expands to inside the repo — deny outright.
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return { ok: false, risk: "home-relative path (~)" };
  }

  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, trimmed);

  // Must stay under the repo root. `path.relative` returns a leading `..`
  // when the resolved target is above / outside the root.
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, risk: "path outside the repo" };
  }

  const base = path.basename(resolved);
  if (DOT_ENV_FILENAME.test(base)) {
    return { ok: false, risk: "reading a .env file" };
  }

  // Every segment of the RESOLVED path (already inside the repo) is
  // checked — a checked-in `.ssh/authorized_keys` still denies.
  const segments = resolved.split(path.sep);
  for (const seg of segments) {
    if (CATASTROPHIC_PATH_SEGMENTS.has(seg.toLowerCase())) {
      return { ok: false, risk: `reading a credential/config path segment (${seg})` };
    }
  }

  return { ok: true };
}

/**
 * The PURE decision function — no I/O, no globals except `env` param. Kept
 * pure so a spec-test can pin the invariant without spawning claude-code.
 *
 * @param toolName    The `tool_name` from the PreToolUse payload.
 * @param toolInput   The `tool_input` object from the PreToolUse payload.
 * @param ticketId    The claimed ticket id (from `REVIEW_CANDIDACY_TICKET_ID`
 *                    env) the runner sets before spawning the session. When
 *                    empty / missing, ALL Bash calls deny (no ticket, no
 *                    grounded shell).
 */
export function decideReviewCandidacyPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  ticketId: string | null,
  repoRoot: string = process.cwd(),
): ReviewCandidacyPermissionDecision {
  // Read / NotebookRead are path-checked — the customer message could name
  // `.env`, `~/.aws/credentials`, or an absolute path outside the repo.
  // Everything else in the read-only set (Grep/Glob/WebSearch/WebFetch/
  // TodoWrite) has no single file_path escape valve into a secret, so
  // stays a blanket allow.
  if (toolName === "Read" || toolName === "NotebookRead") {
    const pathKey = toolName === "Read" ? "file_path" : "notebook_path";
    const check = isRepoScopedReadPath(toolInput[pathKey], repoRoot);
    if (!check.ok) {
      return {
        decision: "deny",
        reason: `review-candidacy: ${toolName} rejected — ${check.risk}`,
      };
    }
    return {
      decision: "allow",
      reason: `review-candidacy: repo-scoped ${toolName}`,
    };
  }

  const READ_ONLY_TOOLS = new Set([
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
    "TodoWrite", // task-tracker; internal to the session, never external
  ]);
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { decision: "allow", reason: `review-candidacy: read-only tool (${toolName})` };
  }

  // Every write tool denies unconditionally — Sol is READ-ONLY. Edit /
  // Write / NotebookEdit / MultiEdit / any file-system mutation.
  const WRITE_TOOLS = new Set([
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Task",
    "Agent",
    "Bash", // handled below with an allowlist — NOT a blanket deny
    "ExitPlanMode",
  ]);

  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!command) {
      return { decision: "deny", reason: "review-candidacy: empty Bash command" };
    }
    for (const c of CATASTROPHIC_BASH_DENY) {
      if (c.re.test(command)) {
        return {
          decision: "deny",
          reason: `review-candidacy: Bash rejected — ${c.risk}`,
        };
      }
    }
    if (isAllowedBashCommand(command, ticketId)) {
      return {
        decision: "allow",
        reason: "review-candidacy: allowlisted read-only Bash",
      };
    }
    return {
      decision: "deny",
      reason:
        "review-candidacy: Bash outside the allowlist (only npx tsx scripts/cx-agent-sdk-tool.ts <ticket_id> / improve-box-tools.ts <ticket_id> + read-only shell builtins are allowed)",
    };
  }

  if (WRITE_TOOLS.has(toolName)) {
    return {
      decision: "deny",
      reason: `review-candidacy: write tool blocked (${toolName})`,
    };
  }

  // MCP or an unknown tool — deny by default. The spec's fix is
  // "allowlist only what's needed"; a novel tool is not needed until it's
  // explicitly added here.
  return {
    decision: "deny",
    reason: `review-candidacy: unknown tool blocked (${toolName || "unnamed"})`,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function emit(verdict: ReviewCandidacyPermissionDecision): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: verdict.reason,
      },
    }),
  );
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> } = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    emit({ decision: "deny", reason: "review-candidacy: PreToolUse payload not JSON" });
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const toolInput =
    payload.tool_input && typeof payload.tool_input === "object"
      ? (payload.tool_input as Record<string, unknown>)
      : {};

  const ticketId =
    typeof process.env.REVIEW_CANDIDACY_TICKET_ID === "string" &&
    /^[a-f0-9-]{10,64}$/i.test(process.env.REVIEW_CANDIDACY_TICKET_ID)
      ? process.env.REVIEW_CANDIDACY_TICKET_ID
      : null;

  emit(decideReviewCandidacyPermission(toolName, toolInput, ticketId, process.cwd()));
}

// Run only when invoked directly (not when imported by a unit test).
if (require.main === module) {
  main().catch((err) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { errText } = require("../src/lib/error-text") as { errText: (e: unknown) => string };
      emit({
        decision: "deny",
        reason: `review-candidacy gate error: ${errText(err)}`,
      });
    } catch {
      process.exit(0);
    }
  });
}
