/**
 * One-off: supersede any active spec-chat coaching whose guidance still frames
 * `docs/brain/specs/{slug}.md` as the artifact — the MD-based-spec framing that
 * `spec-chat-db-authoring-clarity` Phase 2 exists to eliminate. The mechanism
 * (write the scratch buffer THIS turn) is unchanged; only the wording changes:
 * the deliverable is a row in `public.specs` + `public.spec_phases` authored by
 * the deterministic worker via the author-spec SDK's `upsertSpec`; the .md is a
 * throwaway scratch buffer in a worktree the worker discards after parsing —
 * never committed, never the source of truth.
 *
 * Goes through the DIRECTOR-GATED coachAgent path (`coachedBy = 'platform'`) so
 * every write is versioned, superseded, logged in `agent_coaching_log`, and
 * board-posted like any other coaching — never a raw agent_instructions edit.
 *
 * Dry-run by default; pass `--apply` to write.
 *
 *   npx tsx scripts/supersede-spec-chat-md-coaching.ts           # dry-run
 *   npx tsx scripts/supersede-spec-chat-md-coaching.ts --apply   # coach
 *
 * Implements docs/brain/specs/spec-chat-db-authoring-clarity.md Phase 2.
 */
import { createAdminClient } from "./_bootstrap";
import { coachAgent } from "../src/lib/agents/agent-instructions";

const AGENT_KIND = "spec-chat";
const DIRECTOR = "platform";
// Any active row whose guidance still frames the .md as the artifact matches. Case-insensitive.
const MD_MARKERS = [
  "docs/brain/specs/",
  ".md buffer",
  "the complete md",
  "write the md",
  "write the complete .md",
  "author the .md",
];

interface InstructionRow {
  id: string;
  workspace_id: string;
  error_class: string;
  guidance: string;
  triggering_pattern: string | null;
  reasoning: string | null;
}

function guidanceLooksMdFramed(g: string): boolean {
  const s = g.toLowerCase();
  return MD_MARKERS.some((m) => s.includes(m));
}

function correctedGuidance(prior: string): string {
  // Keep the behavior (write the buffer THIS turn — don't just offer), only reframe the artifact.
  return (
    "When you enter finalize mode, WRITE the scratch spec buffer to `docs/brain/specs/{slug}.md` " +
    "in the throwaway worktree THIS turn — the deterministic worker parses that buffer and authors " +
    "the spec to `public.specs` + `public.spec_phases` via the author-spec SDK's `upsertSpec` " +
    "(with a `getSpec` read-back that hard-fails if no row lands), then removes the worktree. The " +
    ".md is a THROWAWAY SCRATCH BUFFER, never committed and never the source of truth — the DB row " +
    "is the artifact. Do NOT stop at 'I could write it' or 'here's the outline'; the buffer must be " +
    "on disk before your call returns, or the worker has nothing to author. " +
    `(Superseded prior wording: "${prior.replace(/"/g, "'").slice(0, 220)}${prior.length > 220 ? "…" : ""}")`
  );
}

const REASONING =
  "spec-chat-db-authoring-clarity Phase 2: the stored guidance was functionally right (write the buffer this turn) but framed docs/brain/specs/{slug}.md as the artifact — an MD-based-spec framing that reads as if specs live in markdown. The DB row is the artifact (public.specs + public.spec_phases via upsertSpec); the .md is a transport scratch buffer the worker discards. Corrected wording preserves the behavior, only reframes the artifact.";

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  const { data, error } = await admin
    .from("agent_instructions")
    .select("id, workspace_id, error_class, guidance, triggering_pattern, reasoning")
    .eq("agent_kind", AGENT_KIND)
    .eq("status", "active");
  if (error) throw new Error(`agent_instructions read failed: ${error.message}`);
  const rows = (data ?? []) as InstructionRow[];

  const candidates = rows.filter((r) => guidanceLooksMdFramed(r.guidance ?? ""));
  console.log(
    `[supersede-spec-chat-md-coaching] scanned ${rows.length} active ${AGENT_KIND} instruction(s); ${candidates.length} still MD-framed`,
  );
  if (!candidates.length) {
    console.log("[supersede-spec-chat-md-coaching] nothing to correct — exiting.");
    return;
  }

  for (const c of candidates) {
    const newGuidance = correctedGuidance(c.guidance);
    const triggeringPattern =
      c.triggering_pattern ||
      "Prior spec-chat coaching under this error_class framed docs/brain/specs/{slug}.md as the artifact instead of the DB row.";
    console.log(
      `\n  workspace=${c.workspace_id} error_class=${c.error_class}\n    OLD: ${c.guidance.slice(0, 200)}${c.guidance.length > 200 ? "…" : ""}\n    NEW: ${newGuidance.slice(0, 200)}…`,
    );
    if (!apply) continue;
    const res = await coachAgent(admin, {
      workspaceId: c.workspace_id,
      agentKind: AGENT_KIND,
      coachedBy: DIRECTOR,
      errorClass: c.error_class,
      guidance: newGuidance,
      triggeringPattern,
      reasoning: REASONING,
    });
    console.log(
      `    ✓ superseded via coachAgent → instruction=${res.instruction.id} coaching=${res.coaching.id} attempt=${res.attempt}`,
    );
  }

  console.log(
    `\n[supersede-spec-chat-md-coaching] ${apply ? "APPLIED" : "DRY-RUN"} · candidates=${candidates.length}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
