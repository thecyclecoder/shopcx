/**
 * workspace-scoped-stale-park-reconcile — pins the workspace_id boundary added to
 * `reconcileStaleParkCards` in `src/lib/agents/approval-inbox.ts` after the pre-merge spec-test on
 * `swap-variant-self-heal-must-not-refire-an-already-landed-swap` flagged three
 * authz/RLS tenant-boundary regressions:
 *   - Family 1c build-stuck auto-clear read `agent_jobs` by `spec_slug` alone: a landed build for the
 *     same slug in ANOTHER workspace would dismiss this workspace's open CEO/build-stuck card.
 *   - Family 1d founder-escalation read `tickets` by `id` alone: a service-role tenant-boundary read
 *     on a customer-facing decision path.
 *   - Shared `loadSpecStatuses` was explicitly workspace-agnostic: a folded spec with the same slug
 *     in another workspace could suppress an active escalation in the reconciled workspace.
 *
 * These regressions do not have a good pure-predicate seam (the loop mixes multiple chained DB reads
 * per family), so we assert on the SOURCE — every write/read that decides card lifetimes carries the
 * `workspace_id` predicate, and `dismissParkCard` scopes its update by both id AND workspace_id.
 *
 *   npx tsx --test src/lib/agents/approval-inbox.workspace-scope.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "approval-inbox.ts"),
  "utf8",
);

/** Grab the body of a named function/section so we can assert predicates local to it. */
function extractSection(marker: string): string {
  const start = SRC.indexOf(marker);
  assert.notEqual(start, -1, `marker not found in approval-inbox.ts: ${marker}`);
  // Take the next ~4KB after the marker — plenty for one family/helper.
  return SRC.slice(start, start + 4000);
}

test("dismissParkCard update is scoped by BOTH id AND workspace_id", () => {
  const body = extractSection("async function dismissParkCard");
  assert.match(body, /\.eq\("id",\s*id\)/, "dismissParkCard must filter by id");
  assert.match(body, /\.eq\("workspace_id",\s*workspaceId\)/, "dismissParkCard must filter by workspace_id");
  assert.match(body, /\.select\("id"\)/, "dismissParkCard must .select('id') so a mismatch is observable");
});

test("loadSpecStatuses queries specs with BOTH workspace_id AND slug and keys the map on the pair", () => {
  const body = extractSection("async function loadSpecStatuses");
  assert.match(body, /\.in\("workspace_id",\s*Array\.from\(workspaces\)\)/, "specs read must filter by workspace_id");
  assert.match(body, /\.in\("slug",\s*Array\.from\(slugs\)\)/, "specs read must filter by slug");
  assert.match(body, /wsKey\(s\.workspace_id,\s*s\.slug\)/, "returned map must be keyed by ${workspace_id}::${slug}");
});

test("Family 1c build-stuck landed-build read is workspace-scoped and latestLanded is keyed by workspace+slug", () => {
  const body = extractSection("── Family 1c: BUILD-STUCK loop-guard cards");
  assert.match(body, /\.from\("agent_jobs"\)/);
  assert.match(body, /\.in\("workspace_id",\s*Array\.from\(workspaces\)\)/, "Family 1c must filter agent_jobs by workspace_id");
  assert.match(body, /\.in\("spec_slug",\s*Array\.from\(slugs\)\)/, "Family 1c must filter agent_jobs by spec_slug");
  assert.match(body, /wsKey\(j\.workspace_id,\s*j\.spec_slug\)/, "latestLanded must be keyed by workspace+slug");
  assert.match(body, /latestLanded\.get\(key\)/, "card lookup must go through the composite key");
});

test("Family 1d founder-escalation ticket read is workspace-scoped and status is keyed by workspace+ticket", () => {
  const body = extractSection("── Family 1d: June's founder escalations");
  assert.match(body, /\.from\("tickets"\)/);
  assert.match(body, /\.in\("workspace_id",\s*Array\.from\(workspaces\)\)/, "Family 1d must filter tickets by workspace_id");
  assert.match(body, /wsKey\(t\.workspace_id,\s*t\.id\)/, "ticketStatus must be keyed by workspace+ticket id");
  assert.match(body, /ticketStatus\.get\(wsKey\(card\.workspace_id,\s*ticketId\)\)/);
});

test("Family 1e universal backstop looks up spec status through the composite workspace+slug key", () => {
  const body = extractSection("── Family 1e: UNIVERSAL BACKSTOP");
  assert.match(body, /wsKey\(card\.workspace_id,\s*specSlug\)/, "orphan card status lookup must be workspace-scoped");
});

test("Family 1b spec-slug-keyed parks scope BOTH the live-park read and the spec status lookup", () => {
  const body = extractSection("── Family 1b: spec-slug-keyed park cards");
  assert.match(body, /\.from\("agent_jobs"\)/);
  assert.match(body, /\.in\("workspace_id",\s*Array\.from\(workspaces\)\)/);
  assert.match(body, /liveParkedKeys\.has\(key\)/, "still-parked test must go through the composite key");
});

test("Family 2 (Reva) spec status lookup goes through the composite workspace+slug key", () => {
  const body = extractSection("── Family 2: Reva");
  assert.match(body, /wsKey\(r\.card\.workspace_id,\s*r\.specSlug\)/);
});

test("no dismissParkCard call remains that doesn't pass a workspace_id (grep the whole file)", () => {
  // Every call site must be `dismissParkCard(admin, <card>.id, <card>.workspace_id, <reason>)`.
  // A three-arg call means a caller regressed to the pre-fix signature.
  const badCalls: string[] = [];
  const rx = /dismissParkCard\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(SRC)) !== null) {
    const args = m[1];
    if (!args) continue;
    // Comma-count (rough) — a legitimate call has 4 args: admin, id, workspaceId, reason.
    // Reasons contain template strings so we tolerate commas inside backticks/parens.
    let depth = 0;
    let commas = 0;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (ch === "(" || ch === "[" || ch === "{" || ch === "`") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === "," && depth === 0) commas++;
    }
    if (commas < 3) badCalls.push(args.trim().slice(0, 100));
  }
  assert.deepEqual(badCalls, [], `dismissParkCard callers must pass workspace_id — regressed callers: ${JSON.stringify(badCalls)}`);
});
