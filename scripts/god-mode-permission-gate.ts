/**
 * god-mode-permission-gate — the box-side PreToolUse hook for the god-mode lane.
 *
 * CEO-grade model (docs/brain/lifecycles/god-mode.md). God-mode is the founder's
 * chief-of-staff with near-unlimited autonomy: it does ALL ordinary work with NO
 * approval — writing code + scripts, running database queries, investigating,
 * editing files, opening PRs, committing, ordinary shell. Writing a script is
 * ALWAYS free even if the script's contents are destructive; the approval, when
 * needed, is on EXECUTING something catastrophic, not on authoring it.
 *
 * This gate is therefore a THIN, DETERMINISTIC FLOOR. It gates exactly ONE thing:
 * a Bash command that matches the CATASTROPHIC rail (dropping tables, wiping data,
 * mass-deleting rows, rm -rf, force-push, resetting the prod DB). Those land a
 * `risk='destructive'` card and BLOCK until the founder approves WITH their PIN.
 * Everything else auto-allows.
 *
 * The other half of the model — routing genuine CEO-grade DECISIONS to the founder
 * in plain language ("ok to ship this hotfix?", "ok to dismiss these?") — is NOT
 * done here. The BOX raises those itself, by judgment, via
 * `scripts/god-mode-plan.ts decide` (a plain-language `risk='decision'` card, which
 * this gate simply allows since it's an ordinary non-catastrophic call). The gate
 * is the safety backstop; the box's judgment is the primary supervisor.
 *
 * Contract (Claude Code hooks): stdin = PreToolUse JSON {tool_name, tool_input};
 * env GOD_MODE_SESSION_ID; stdout = {hookSpecificOutput:{permissionDecision}}; exit 0.
 */
import "./_bootstrap";
import { errText } from "../src/lib/error-text";
import { createAdminClient } from "./_bootstrap";
import { openApproval, getApproval, isSessionArmed, type GodModeApprovalRisk } from "../src/lib/god-mode";

// ── The CATASTROPHIC floor — the ONLY things this gate blocks. Narrow by design:
// truly irreversible / company-endangering actions. Each pairs with a plain-language
// description the founder sees (never the raw command as the headline). Matched over
// the Bash command text; false positives are safe (harder to run), false negatives
// are the risk — so keep the set tight but the box's own judgment covers the rest.
const CATASTROPHIC: readonly { re: RegExp; plain: string }[] = [
  { re: /\brm\s+-[rf]*(r[rf]*f|f[rf]*r)[rf]*\b/i, plain: "Permanently delete files or folders — this cannot be undone." },
  { re: /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|POLICY|VIEW|FUNCTION|COLUMN|TYPE|SEQUENCE)\b/i, plain: "Drop a database object (table/schema/etc.) — destroys its data permanently." },
  { re: /\bTRUNCATE\b/i, plain: "Wipe every row from a database table — this cannot be undone." },
  // DELETE FROM with NO WHERE clause = a mass delete. A targeted DELETE … WHERE is
  // ordinary work and auto-allows (the box escalates a plain decision if it's a big call).
  { re: /\bDELETE\s+FROM\b(?![\s\S]*\bWHERE\b)/i, plain: "Delete ALL rows from a database table (no filter) — this cannot be undone." },
  { re: /\bgit\s+push\s+.*(--force\b|--force-with-lease\b|-f\b)/i, plain: "Force-push to git — this can permanently overwrite history and lose commits." },
  { re: /\bsupabase\s+db\s+reset\b/i, plain: "Reset the database — destroys ALL data." },
];

function catastrophic(command: string): { plain: string } | null {
  for (const c of CATASTROPHIC) if (c.re.test(command)) return { plain: c.plain };
  return null;
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
  if (!sessionId) emit("deny", "god-mode gate: GOD_MODE_SESSION_ID not set (bug — the runner must set this)");

  const raw = await readStdin();
  let payload: { tool_name?: string; tool_input?: Record<string, unknown> } = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    emit("deny", "god-mode gate: could not parse PreToolUse payload");
  }
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const toolInput = payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {};

  const admin = createAdminClient();

  // If the founder disarmed mid-call, deny fast (belt-and-suspenders — the turn ends anyway).
  if (!(await isSessionArmed(admin, sessionId!))) emit("deny", "god mode is disarmed — call not allowed");

  // The ONLY gated path: a Bash command on the catastrophic floor. Everything else
  // — writes, edits, scripts, DB queries, ordinary shell, git, PRs, MCP/unknown
  // tools — auto-allows. Writing a script is always free (even destructive contents);
  // only EXECUTING a catastrophic command lands here.
  const command = toolName === "Bash" && typeof toolInput.command === "string" ? toolInput.command : "";
  const cat = command ? catastrophic(command) : null;
  if (!cat) {
    emit("allow", `god-mode gate: auto-allowed (${toolName || "tool"})`);
  }

  // Land the catastrophic-approval card and poll until the founder decides (with PIN).
  const { data: session } = await admin
    .from("god_mode_sessions")
    .select("workspace_id")
    .eq("id", sessionId!)
    .maybeSingle();
  if (!session) emit("deny", "god-mode gate: session not found");

  const risk: GodModeApprovalRisk = "destructive";
  const row = await openApproval(admin, {
    sessionId: sessionId!,
    workspaceId: (session as { workspace_id: string }).workspace_id,
    toolName,
    toolInput,
    // Plain-language headline + the raw command underneath, so the founder decides
    // on the CONSEQUENCE, not the syntax.
    preview: `${cat.plain}\n\nCommand: ${command}`,
    risk,
  });

  const POLL_MS = 2000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const fresh = await getApproval(admin, row.id);
    if (!fresh) emit("deny", "god-mode gate: approval row disappeared");
    if (fresh!.status === "pending") {
      if (!(await isSessionArmed(admin, sessionId!))) emit("deny", "god mode was disarmed while waiting for approval");
      continue;
    }
    if (fresh!.status === "approved") emit("allow", "god-mode gate: approved (with PIN)");
    if (fresh!.status === "denied") emit("deny", "god-mode gate: the founder declined this action");
    if (fresh!.status === "asked") {
      const q = fresh!.question_text ?? "(no question text)";
      emit("deny", `god-mode gate: the founder asked — "${q}" — answer in your reply, then re-request if still needed.`);
    }
  }
}

main().catch((err) => {
  try {
    emit("deny", `god-mode gate error: ${errText(err)}`);
  } catch {
    process.exit(0);
  }
});
