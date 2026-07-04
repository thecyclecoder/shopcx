/**
 * god-mode-permission-gate — the box-side PreToolUse hook for the god-mode lane.
 *
 * Phase 2 of docs/brain/specs/god-mode.md. Wired into the `claude -p` invocation
 * for `kind='god-mode'` via `--settings` inline JSON that carries a PreToolUse
 * hook pointing at this script (runGodModeJob in scripts/builder-worker.ts).
 *
 * Contract (Claude Code hooks):
 *   • stdin  — JSON: { session_id, tool_name, tool_input, ... } (Claude Code
 *              PreToolUse event payload).
 *   • env    — GOD_MODE_SESSION_ID is set by runGodModeJob to the god-mode
 *              session UUID (NOT the Claude session id) so the gate can insert
 *              approval rows and poll them.
 *   • stdout — JSON: { hookSpecificOutput: { hookEventName: "PreToolUse",
 *              permissionDecision: "allow"|"deny", permissionDecisionReason: "..." } }
 *              For an 'asked' outcome we return `deny` with the founder's
 *              question in `permissionDecisionReason` so the box reads it and
 *              can respond in-transcript (a live back-and-forth, not dead end).
 *   • exit   — 0 always (we express the decision via the JSON envelope).
 *
 * Behavior:
 *   • SAFE — Read/Grep/Glob/WebSearch/WebFetch, an allowlist of read-only Bash
 *            prefixes (git status/diff/log, ls, cat, pwd, npx tsc, wc, head,
 *            tail, find, printf, node -v, npm -v, SELECT-only psql). Auto-allow;
 *            no god_mode_approvals row is inserted.
 *   • WRITE — everything else that isn't destructive. Inserts a god_mode_approvals
 *            row (status='pending', risk='write'), polls until it flips, returns
 *            allow on 'approved' and deny on 'denied'.
 *   • DESTRUCTIVE — matches a deterministic rail (drop/delete/truncate/force-push
 *            /rm -rf, DROP/TRUNCATE/DELETE FROM SQL). Same insert + poll, but
 *            risk='destructive'. The Phase-3 approve route verifies the founder
 *            PIN against workspaces.god_mode_pin_hash before flipping to
 *            'approved' — this gate just waits for the row to be resolved.
 *   • ASK — the founder answered with a question. We return deny WITH the
 *           question text in the reason so the box reads it and replies in
 *           transcript, then re-requests approval on the next tool call.
 *
 * If the session has been disarmed while a tool call was in-flight, the gate
 * denies (belt-and-suspenders — the runGodModeJob turn ends anyway).
 */
import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import {
  openApproval,
  getApproval,
  isSessionArmed,
  type GodModeApprovalRisk,
} from "../src/lib/god-mode";

// ── Read-only Bash prefixes — the safe subset that auto-allows without ─────
// ── landing a god_mode_approvals row. Extend cautiously; every entry is a ──
// ── surface that runs against the box unattended.                         ──
const SAFE_BASH_PREFIXES: readonly string[] = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git remote -v",
  "git ls-files",
  "git ls-remote",
  "git rev-parse",
  "git config --get",
  "ls",
  "cat",
  "pwd",
  "wc",
  "head",
  "tail",
  "find ",
  "which ",
  "printf",
  "node -v",
  "node --version",
  "npm -v",
  "npm --version",
  "npx tsc --noEmit",
  "npx tsc --version",
  "grep ",
  "rg ",
  "gh pr list",
  "gh pr view",
  "gh issue list",
  "gh issue view",
  "gh run list",
  "gh run view",
];

// ── Read-only tool names that never need approval. ─────────────────────────
const SAFE_TOOLS = new Set<string>([
  "Read",
  "Grep",
  "Glob",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

// ── Destructive-command rails (regex over the command text). Rough but ────
// ── deterministic — the founder can still approve; this only routes the ───
// ── card to risk='destructive' so the PIN gate applies. False positives ────
// ── are safe (harder to approve); false negatives are the real risk.  ─────
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[rf]+\b/i,
  /\brm\s+-r\s+-f\b/i,
  /\brmdir\b/i,
  /\bgit\s+push\s+.*--force\b/i,
  /\bgit\s+push\s+-f\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-f\b/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|COLUMN|POLICY|VIEW|FUNCTION)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+TABLE\s+.*\s+DROP\b/i,
  /\bshutdown\b/i,
  // supabase / prod DB deploy commands
  /\bsupabase\s+db\s+(reset|push)\b/i,
  // vercel prod deploys
  /\bvercel\s+.*(--prod|deploy\s+--prod)\b/i,
];

// Shell metacharacters that permit chaining, redirection, subshell, or command
// substitution. If ANY of these appear in a command, the "prefix looks safe"
// heuristic can't guarantee safety anymore — a chained `ls; rm -rf /tmp`
// slipped through the old prefix-match. Fail-closed on any of these.
//   ; & |  → command chaining / pipelines
//   ` $(   → command substitution
//   > <    → redirection (could clobber, could exfil)
//   \n     → newline-embedded second statement
const SHELL_METACHAR_RE = /[;&|`$<>\n]|\$\(/;

function isSafeBash(command: string): boolean {
  const c = command.trim();
  // psql with a plain SELECT is safe. Anything containing a semicolon-separated
  // second statement or SQL keywords other than SELECT is not.
  if (/^psql\b/i.test(c)) {
    // Extract the -c payload (best-effort). If it's a SELECT only, allow.
    const m = c.match(/-c\s+['"](.+)['"]/);
    if (m) {
      const sql = m[1].trim();
      if (/^select\b/i.test(sql) && !/;\s*\S/.test(sql)) return true;
      return false;
    }
    return false;
  }
  // Whole-command must fall UNDER an allowlist prefix — either the exact
  // prefix or `prefix<space>...`. The previous `c.startsWith(prefix)` clause
  // (no trailing space) was the bypass vector: `ls;rm -rf /` prefix-matched
  // `ls` and slipped through as "safe". Removed.
  const matchedPrefix = SAFE_BASH_PREFIXES.some((prefix) => c === prefix || c.startsWith(prefix + " "));
  if (!matchedPrefix) return false;
  // Even under an allowlisted prefix, reject any shell metacharacter that
  // permits chaining / substitution / redirection. `ls; rm -rf /tmp` and
  // `ls && cat /etc/passwd` and `cat "$(curl attacker)"` all fail here.
  if (SHELL_METACHAR_RE.test(c)) return false;
  return true;
}

function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

function classify(toolName: string, toolInput: Record<string, unknown>): {
  decision: "safe" | "needs_approval";
  risk: GodModeApprovalRisk;
  preview: string;
} {
  if (SAFE_TOOLS.has(toolName)) {
    return { decision: "safe", risk: "safe", preview: toolName };
  }
  if (toolName === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!command) return { decision: "needs_approval", risk: "write", preview: "Bash (no command)" };
    // Belt-and-suspenders: even under isSafeBash-true, if the destructive rail
    // matches, force needs_approval risk='destructive'. Guards against a novel
    // destructive-command shape that slipped into an allowlisted prefix (e.g.
    // `git branch -D main` — `git branch` is allowlisted but the `-D` deletes).
    // The PIN gate on the destructive approval remains the enforcement point.
    if (isDestructive(command)) {
      return { decision: "needs_approval", risk: "destructive", preview: `Bash: ${command}` };
    }
    if (isSafeBash(command)) return { decision: "safe", risk: "safe", preview: `Bash: ${command}` };
    return { decision: "needs_approval", risk: "write", preview: `Bash: ${command}` };
  }
  if (toolName === "Write" || toolName === "Edit") {
    const path = typeof toolInput.file_path === "string" ? toolInput.file_path : "?";
    return { decision: "needs_approval", risk: "write", preview: `${toolName} ${path}` };
  }
  if (toolName === "NotebookEdit") {
    const path = typeof toolInput.notebook_path === "string" ? toolInput.notebook_path : "?";
    return { decision: "needs_approval", risk: "write", preview: `NotebookEdit ${path}` };
  }
  // Unknown tool — default to needs-approval (fail-safe).
  return { decision: "needs_approval", risk: "write", preview: `${toolName} (unknown tool)` };
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function emit(decision: "allow" | "deny", reason: string): never {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

async function main() {
  const sessionId = process.env.GOD_MODE_SESSION_ID;
  if (!sessionId) {
    // Fail closed — no way to record a decision without a session context.
    emit("deny", "god-mode gate: GOD_MODE_SESSION_ID not set (bug — the runner must set this)");
  }

  const raw = await readStdin();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> } = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    emit("deny", "god-mode gate: could not parse PreToolUse payload");
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const toolInput =
    payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};

  const admin = createAdminClient();

  // If the founder disarmed the session mid-call, deny fast. The runGodModeJob
  // stream also detects this and tears down, but the belt-and-suspenders here
  // keeps a mid-turn tool from executing after disarm.
  if (!(await isSessionArmed(admin, sessionId!))) {
    emit("deny", "god mode is disarmed — call not allowed");
  }

  const cls = classify(toolName, toolInput);
  if (cls.decision === "safe") {
    emit("allow", `god-mode gate: auto-allowed (${cls.preview})`);
  }

  // Land the approval row and poll until the founder decides.
  const { data: session } = await admin
    .from("god_mode_sessions")
    .select("workspace_id")
    .eq("id", sessionId!)
    .maybeSingle();
  if (!session) emit("deny", "god-mode gate: session not found");

  const row = await openApproval(admin, {
    sessionId: sessionId!,
    workspaceId: (session as { workspace_id: string }).workspace_id,
    toolName,
    toolInput,
    preview: cls.preview,
    risk: cls.risk,
  });

  // Poll. No hard cap — a founder may sleep on it; the outer session timeout
  // is what kills a truly forgotten call. If the session disarms while
  // polling, exit deny.
  const POLL_MS = 2000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const fresh = await getApproval(admin, row.id);
    if (!fresh) emit("deny", "god-mode gate: approval row disappeared");
    if (fresh.status === "pending") {
      // If the session was disarmed while we were waiting, bail.
      if (!(await isSessionArmed(admin, sessionId!))) {
        emit("deny", "god mode was disarmed while waiting for approval");
      }
      continue;
    }
    if (fresh.status === "approved") {
      emit("allow", `god-mode gate: approved (${fresh.risk})`);
    }
    if (fresh.status === "denied") {
      emit("deny", `god-mode gate: denied (${fresh.risk})`);
    }
    if (fresh.status === "asked") {
      // Return deny WITH the question so the box reads it in the reason and
      // can respond in-transcript. The Phase-3 UI is what surfaces the ask;
      // this text is what the box sees inline.
      const q = fresh.question_text ?? "(no question text)";
      emit("deny", `god-mode gate: the founder asked — "${q}" — respond in transcript, then re-request this tool.`);
    }
  }
}

main().catch((err) => {
  // Any thrown error → fail closed.
  try {
    emit("deny", `god-mode gate error: ${err instanceof Error ? err.message : String(err)}`);
  } catch {
    process.exit(0);
  }
});
