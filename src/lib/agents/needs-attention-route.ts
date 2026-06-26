/**
 * needs-attention-route — auto-route parked agent_jobs by their classification class
 * ([[../../docs/brain/specs/no-parked-specs-auto-route-needs-attention.md]] Phases 1–4).
 *
 * needs_attention used to be a terminal state — the worker parked, and the spec sat. This module
 * is the standing sweep that drains the parked feed into the right onward action based on the
 * Phase-0 [[needs-attention-classify]] verdict:
 *
 *   Phase 1 — already_shipped → fold the spec into the brain (enqueue_fold + flip card-state to
 *             shipped via the spec-status writer; appends a spec_status_history actor=director:platform).
 *   Phase 2 — real_blocker / tooling_failure → author a child spec (`{slug}-fix-{class}`) owned by
 *             Platform, parented at the original. Flip the original spec phase back to planned and
 *             write the Blocked-by line; the standing escort builds the child next pass.
 *   Phase 3 — design_change → invite the CEO to chat via the existing #cto-ada surface
 *             ([[../specs/ada-slack-routed-approvals]] Phase 3 chat-mode invitation pattern).
 *             The only park class that legitimately surfaces to the CEO.
 *   Phase 4 — backstop sweep + alarm: a `needs_attention` row older than 60 min that isn't routed
 *             yet (classifier returned `unknown` OR the routing job failed) forces a director pass;
 *             a spec sitting >70 min in `needs_attention` posts a dashboard_notifications alarm.
 *
 * All routers are DORMANT until Platform is live + autonomous (same guard as every other lane on
 * `platform-director.ts`), bounded per pass, and dedupe on a `routed_needs_attention` /
 * `routed_park_alarm` `director_activity` row so a re-run never double-routes. Each routing action
 * also clears the job's `needs_attention_class` to a routed-followup marker so subsequent sweeps
 * leave it alone.
 *
 * Best-effort: a single failed route never aborts the pass. The caller logs the result one-liner.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  PLATFORM,
  platformIsAutoApprover,
  escalateDiagnosisToCeo,
} from "@/lib/agents/platform-director";
import { loadAutonomyMap } from "@/lib/agents/approval-router";
import { recordDirectorActivity } from "@/lib/director-activity";
import { markSpecCardStatus } from "@/lib/spec-card-state";
import { getSpec } from "@/lib/brain-roadmap";
import { classifyAndStamp, type NeedsAttentionClass } from "@/lib/agents/needs-attention-classify";

type Admin = ReturnType<typeof createAdminClient>;

/** Cap how many routing actions one pass takes (across all classes). */
export const PLATFORM_DIRECTOR_ROUTE_CAP = 8;

/** The window the backstop sweep parks a row as "left to rot" — Phase 4 escalates past this. */
export const NEEDS_ATTENTION_STALE_MS = 60 * 60 * 1000; // 60 min — spec invariant
export const NEEDS_ATTENTION_ALARM_MS = 70 * 60 * 1000; // 70 min — alarm threshold (zero target after Phase 4)

/** Marker class written back onto a routed row so subsequent passes leave it alone. */
const ROUTED_MARKER: Record<NeedsAttentionClass, string | null> = {
  already_shipped: "routed_already_shipped",
  real_blocker: "routed_real_blocker",
  tooling_failure: "routed_tooling_failure",
  design_change: "routed_design_change",
  unknown: null, // never routed by a class router — the backstop sweep handles it
};

/**
 * Classes the auto-router NEVER re-processes — a dismiss-park action ([[../specs/director-dismiss-park-and-short-circuit-spec]] Phase 1)
 * flips the parked row to status='dismissed' AND stamps this class, so the auto-router can't see it (the
 * status filter alone excludes it; the class check is belt-and-suspenders in case a future caller leaves
 * the row needs_attention while the class is dismissed_by_director). A wrongly-dismissed park is one
 * "Re-open" click from the CEO's activity feed away — that clears the class + flips status back.
 */
const TERMINAL_DIRECTOR_CLASSES: ReadonlySet<string> = new Set(["dismissed_by_director"]);

/** Kinds another standing lane already owns — these don't get auto-routed by THIS sweep. */
const SKIP_KINDS: ReadonlySet<string> = new Set(["platform-director", "fold"]);

/**
 * Kinds that are NON-SPEC jobs — they don't open a PR against a spec, so the four class routers
 * (fold / child-spec / chat / backstop-CEO) can't act on them, AND the 70-min invariant alarm is
 * irrelevant ("a spec sitting 70 min in needs_attention" — there is no spec). A parked
 * `ticket-improve` (a one-shot ticket co-pilot turn — [[../../docs/brain/specs/ticket-improve-park-auto-route.md]])
 * would otherwise fall to `unknown`, sit 60 min, and surface to the CEO for nothing the CEO can do
 * about it — the right terminal is to DISMISS the park (reversible: one CEO click on the activity
 * row to re-open). Extend this set when a new non-spec job kind goes live.
 */
const NON_SPEC_KINDS: ReadonlySet<string> = new Set(["ticket-improve"]);

export interface RouteResult {
  /** specs whose park flipped to fold (Phase 1). */
  folded: string[];
  /** specs whose park spawned a child blocker spec (Phase 2). */
  spawned: string[];
  /** specs whose park invited the CEO to chat (Phase 3). */
  chatted: string[];
  /** specs forced through a backstop investigation (Phase 4 — `unknown` class survived 60 min). */
  backstopped: string[];
  /** specs that posted the 70-min park alarm (Phase 4 invariant). */
  alarmed: string[];
  /** non-spec jobs whose park auto-resolved to `dismissed` (NON_SPEC_KINDS — e.g. ticket-improve). */
  dismissed: string[];
  /** parked rows examined this pass. */
  scanned: number;
}

interface ParkedRow {
  id: string;
  workspace_id: string;
  kind: string;
  spec_slug: string | null;
  error: string | null;
  log_tail: string | null;
  needs_attention_class: NeedsAttentionClass | null;
  created_at: string;
}

interface RoutedLedger {
  routed: Set<string>;
  alarmed: Set<string>;
}

async function loadLedger(admin: Admin): Promise<RoutedLedger> {
  const { data } = await admin
    .from("director_activity")
    .select("action_kind, metadata, created_at")
    .eq("director_function", PLATFORM)
    .in("action_kind", ["routed_needs_attention", "routed_park_alarm"])
    .order("created_at", { ascending: false })
    .limit(2000);
  const routed = new Set<string>();
  const alarmed = new Set<string>();
  for (const a of (data ?? []) as Array<{ action_kind: string; metadata: Record<string, unknown> | null }>) {
    const m = a.metadata ?? {};
    const jid = typeof m.job_id === "string" ? m.job_id : null;
    if (!jid) continue;
    if (a.action_kind === "routed_needs_attention") routed.add(jid);
    if (a.action_kind === "routed_park_alarm") alarmed.add(jid);
  }
  return { routed, alarmed };
}

/**
 * Stamp the routed marker class back on the job so the next sweep skips it. Best-effort.
 */
async function markRouted(admin: Admin, jobId: string, klass: NeedsAttentionClass): Promise<void> {
  const marker = ROUTED_MARKER[klass];
  if (!marker) return;
  try {
    await admin
      .from("agent_jobs")
      .update({ needs_attention_class: marker, updated_at: new Date().toISOString() })
      .eq("id", jobId);
  } catch (e) {
    console.warn(`[needs-attention-route] mark routed failed for ${jobId}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Clear a park the director ALREADY routed on a prior pass (its class is a `routed_*` marker) but that
 * was left in `needs_attention`. Routing IS the disposition — the fold / child-spec / chat followup is
 * the live surface now, so the parked job has no further role; leaving it parked makes it a zombie that
 * self-watch ("build stuck >90m") and the needs-attention triage ("N parked, all triaged") re-report
 * every standing pass forever (the appstle-switch-payment-method-edit-guardrail board loop, 2026-06-26).
 *
 * Flip it to the terminal `completed` (the same terminal a superseded/held build and the dismiss-park
 * action already use — director-directives `holdOutOfOrderBuilds`, platform-director dismiss) so it
 * leaves needs_attention. Reversible via the [[director_activity]] ledger. Best-effort; re-asserts the
 * status so it never flips a row that changed under us.
 */
async function clearRoutedZombie(admin: Admin, row: ParkedRow): Promise<boolean> {
  const { error } = await admin
    .from("agent_jobs")
    .update({
      status: "completed",
      error: `routed park cleared: '${row.needs_attention_class}' disposition already actioned — leaving needs_attention`.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "needs_attention"); // never resurrect a row that already moved on
  if (error) {
    console.warn(`[needs-attention-route] clear routed zombie failed for ${row.id}: ${error.message}`);
    return false;
  }
  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: PLATFORM,
    actionKind: "routed_needs_attention",
    specSlug: row.spec_slug,
    reason: `Cleared a routed park left in needs_attention ('${row.needs_attention_class}') — disposition already actioned; row is terminal.`,
    metadata: { job_id: row.id, action: "clear_routed_zombie", prior_class: row.needs_attention_class, target_kind: row.kind, autonomous: true },
  });
  return true;
}

// Commit the child blocker spec markdown to main via the GitHub Contents API (Phase 2). Mirrors
// `ghCommitSpec` in agent-grader.ts — works from both the deployed runtime + the box, get-then-PUT
// so it updates in place. Returns true on success; false on missing token / API failure.
const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}
async function commitChildSpec(slug: string, content: string, message: string): Promise<boolean> {
  const token = ghToken();
  if (!token) return false;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const path = `docs/brain/specs/${slug}.md`;
  let sha: string | undefined;
  try {
    const get = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=main`, { headers, cache: "no-store" });
    if (get.ok) sha = ((await get.json()) as { sha?: string }).sha;
  } catch {
    /* new file */
  }
  const put = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: Buffer.from(content, "utf8").toString("base64"), sha, branch: "main" }),
  });
  return put.ok;
}

/** A safe-but-strict slug builder for the child blocker spec (Phase 2). */
function childSpecSlug(originSlug: string, klass: NeedsAttentionClass, jobId: string): string {
  const base = originSlug.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 40).replace(/^-+|-+$/g, "");
  const suffix = klass === "real_blocker" ? "fix-blocker" : "fix-tooling";
  const tag = jobId.slice(0, 6);
  return `${base || "park"}-${suffix}-${tag}`;
}

/**
 * Phase 1 — auto-fold the spec when the park class is `already_shipped`.
 *
 * Verifies the spec actually exists, the spec is not archived, and (best-effort) flips its card to
 * shipped via the spec-status writer (`markSpecCardStatus` — actor=director:platform appends
 * spec_status_history). Then enqueues a `fold` job through the SAME `enqueue_fold` RPC the machine
 * spec-test pass / manual "Fold to brain now" override use so the spec rides the next batch (no fan-out of N fold PRs).
 *
 * Idempotent: ledger-deduped per job + the `enqueue_fold` RPC itself coalesces. Best-effort per row.
 */
async function routeAlreadyShipped(admin: Admin, row: ParkedRow): Promise<boolean> {
  if (!row.spec_slug) return false;
  // Sanity: the spec should exist on disk (an `already_shipped` verdict on a missing spec is itself
  // a routing failure — leave it for the backstop). getSpec reads the bundled disk + DB mirror.
  const spec = await getSpec(row.spec_slug, row.workspace_id);
  if (!spec) return false;

  // Card flip → shipped (no markdown commit; the DB mirror is the live signal). Append the audit
  // entry so spec_status_history records WHO routed it (director:platform), matching the spec.
  try {
    await markSpecCardStatus(
      row.workspace_id,
      row.spec_slug,
      "shipped",
      spec.card.phases.map((p, i) => ({ index: i, title: p.title, status: "shipped" as const })),
      {
        actor: "director:platform",
        reason: `Auto-routed: build parked already_shipped — flipping to shipped + folding into the brain.`,
      },
    );
  } catch (e) {
    console.warn(`[needs-attention-route] markSpecCardStatus failed for ${row.spec_slug}:`, e instanceof Error ? e.message : e);
  }

  // Enqueue the fold via the existing RPC — coalesces into the next batch fold-build automatically.
  const { error } = await admin.rpc("enqueue_fold", { p_workspace: row.workspace_id, p_slug: row.spec_slug, p_user: null });
  if (error) {
    console.warn(`[needs-attention-route] enqueue_fold failed for ${row.spec_slug}: ${error.message}`);
    return false;
  }

  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: PLATFORM,
    actionKind: "routed_needs_attention",
    specSlug: row.spec_slug,
    reason: `Auto-routed parked ${row.kind} ${row.id.slice(0, 8)} (already_shipped) → flipped spec to shipped + enqueued fold.`,
    metadata: { job_id: row.id, action: "fold", target_kind: row.kind, autonomous: true },
  });
  await markRouted(admin, row.id, "already_shipped");
  return true;
}

/**
 * Phase 2 — auto-spec the blocker when the park class is `real_blocker` or `tooling_failure`.
 *
 * Authors a child spec via the existing `kind='spec'` PendingAction shape the planner uses
 * ([[goal-decomposition-engine]]): a `proposed-spec` `agent_jobs` row carrying the new spec body
 * for the worker to write to `docs/brain/specs/{slug}.md` on its standing pass. Owner = Platform,
 * parent = the original spec (so the orphan-spec rule holds). Marks **Priority:** critical when the
 * origin was critical.
 *
 * Then writes a `**Blocked-by:** [[{child}]]` line patch to the origin via the spec-status writer
 * (markSpecCardBlocked + a card-state metadata stash carrying the child slug) so the board renders
 * the origin as gated until the child ships. The original WAITS; the standing build escort picks
 * up the child next pass.
 *
 * Best-effort: a row whose spec is missing falls back to a CEO escalation (the spec a `real_blocker`
 * named couldn't be found → human triage is the right answer).
 */
async function routeAuthorBlocker(admin: Admin, row: ParkedRow, klass: "real_blocker" | "tooling_failure"): Promise<boolean> {
  if (!row.spec_slug) return false;
  const originSpec = await getSpec(row.spec_slug, row.workspace_id);
  if (!originSpec) return false; // backstop will surface to CEO

  const childSlug = childSpecSlug(row.spec_slug, klass, row.id);
  const priorityLine = originSpec.card.critical ? `\n**Priority:** critical\n` : "";
  const title =
    klass === "real_blocker"
      ? `${row.spec_slug} — fix the blocker uncovered by the build`
      : `${row.spec_slug} — fix the tooling failure that parked the build`;
  const intent =
    klass === "real_blocker"
      ? `The build of [[../specs/${row.spec_slug}]] parked with a real blocker the spec didn't declare. Author the missing prerequisite (API surface, schema change, dependency) so the origin can resume.`
      : `The build of [[../specs/${row.spec_slug}]] parked because the agent itself failed to produce a verdict (the ${row.kind} pipeline's tooling, not the origin's content). Fix the tool so the origin's build can run cleanly.`;
  const evidence = `Park reason: ${(row.error ?? "(none recorded)").slice(0, 300)}\nLog tail: ${(row.log_tail ?? "(none)").slice(-400)}`;
  const content = `# ${childSlug}

**Owner:** [[../functions/platform]]
**Parent:** [[../specs/${row.spec_slug}]]${priorityLine}
**Status:** ⏳ Planned

## Why

Auto-authored by Ada (Platform/DevOps Director) from a parked ${row.kind} on [[../specs/${row.spec_slug}]] (job ${row.id.slice(0, 8)}, class \`${klass}\`).

${intent}

### Evidence

\`\`\`
${evidence}
\`\`\`

## Phases

### Phase 1 — diagnose + fix
- ⏳ Read the parked job's reason + log tail above. Trace the failure into the implicated code path.
- ⏳ Author the minimum change that unblocks the origin (a new surface, a schema migration, a tooling
  guard, or a corrected agent prompt — whichever the trace points to).
- ⏳ Verify: re-running the origin build should now produce a non-parked verdict.

## Verification

- The origin spec [[../specs/${row.spec_slug}]] builds without re-parking under class \`${klass}\`.
- (For \`tooling_failure\`) the agent that parked produces a parseable verdict on a fresh invocation
  against a representative input.
`;

  // Commit the child spec to main FIRST (so the build pipeline finds it on origin/main), then
  // queue its build. Same authoring pattern as `rollCoachingIntoFixSpec` (agent-grader.ts) — works
  // from both the deployed runtime and the box. A failed commit aborts the route (no half-step).
  const committed = await commitChildSpec(childSlug, content, `spec: ${childSlug} — auto-author from parked ${row.kind} ${row.id.slice(0, 8)} (class=${klass})`);
  if (!committed) {
    console.warn(`[needs-attention-route] child spec commit FAILED for ${childSlug} — leaving origin parked for the backstop`);
    return false;
  }

  const { error } = await admin.from("agent_jobs").insert({
    workspace_id: row.workspace_id,
    spec_slug: childSlug,
    kind: "build",
    status: "queued",
    created_by: null,
    instructions: `Auto-authored by needs-attention router (class=${klass}). Origin: [[../specs/${row.spec_slug}]]. Build the just-committed child spec.`,
  });
  if (error) {
    console.warn(`[needs-attention-route] enqueue child build failed for ${row.spec_slug}: ${error.message}`);
    return false;
  }

  // Origin's card → blocked + carry the child slug so the board can render the wait.
  try {
    const { data: existing } = await admin
      .from("spec_card_state")
      .select("flags")
      .eq("workspace_id", row.workspace_id)
      .eq("spec_slug", row.spec_slug)
      .maybeSingle();
    const priorFlags = ((existing as { flags?: Record<string, unknown> } | null)?.flags as Record<string, unknown>) ?? {};
    const flags = { ...priorFlags, blocked: true, blocked_by_child: childSlug };
    await admin
      .from("spec_card_state")
      .upsert(
        { workspace_id: row.workspace_id, spec_slug: row.spec_slug, flags, updated_at: new Date().toISOString() },
        { onConflict: "workspace_id,spec_slug" },
      );
  } catch (e) {
    console.warn(`[needs-attention-route] origin block flag failed for ${row.spec_slug}:`, e instanceof Error ? e.message : e);
  }

  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: PLATFORM,
    actionKind: "routed_needs_attention",
    specSlug: row.spec_slug,
    reason: `Auto-routed parked ${row.kind} ${row.id.slice(0, 8)} (${klass}) → authored child spec ${childSlug}; original waits.`,
    metadata: { job_id: row.id, action: "child_spec", target_kind: row.kind, child_slug: childSlug, klass, autonomous: true },
  });
  await markRouted(admin, row.id, klass);
  return true;
}

/**
 * Phase 3 — invite the CEO to chat when the park class is `design_change`.
 *
 * Reuses the [[../specs/ada-slack-routed-approvals]] Phase 3 chat-mode invitation lane: a short
 * `can we chat about this spec?` message in #cto-ada that opens a `director_coach_threads` row
 * pre-seeded with the parked job's context. The conversation produces a spec-edit or a new spec —
 * never a raw log dump or bare approve button.
 *
 * Implemented as a CEO-routed `dashboard_notifications` row carrying the chat invitation flag, so
 * the existing `reconcileApprovalInbox` Phase 3 dispatcher posts the invitation to Slack on its
 * next tick (no new Slack code path). The notification's metadata carries `chat_mode=true` and the
 * parked job id so the box turn lands with full context.
 */
async function routeDesignChange(admin: Admin, row: ParkedRow): Promise<boolean> {
  // The escalateDiagnosisToCeo helper already emits a CEO-routed Approval Request the inbox
  // reconciler picks up; we tag it `chat_mode_request:true` so the Slack mirror posts an
  // invitation thread instead of an Approve/Reject card (the existing chat-mode rules already
  // fire for brain-touching / long-preview items; this metadata forces it for our class).
  const title = `Design check: ${row.spec_slug ?? row.kind} — the build flagged the spec design`;
  const diagnosis = `A ${row.kind} build of ${row.spec_slug ? `[[../specs/${row.spec_slug}]]` : "this job"} parked with class design_change — the build revealed the spec's design is materially wrong (not a fixable bug). I'd rather talk through what the right re-spec or new spec looks like than hand you a diff to approve. Park reason: ${(row.error ?? "(none recorded)").slice(0, 300)}.`;
  const r = await escalateDiagnosisToCeo(admin, {
    workspaceId: row.workspace_id,
    specSlug: row.spec_slug,
    title,
    diagnosis,
    dedupeKey: `parkchat:${row.id}`,
    deepLink: row.spec_slug ? `/dashboard/roadmap/${row.spec_slug}` : "/dashboard/developer/control-tower",
    escalationKind: "park_design_change",
    metadata: {
      kind: "needs_attention_design_change",
      job_id: row.id,
      target_kind: row.kind,
      chat_mode_request: true, // ada-slack-routed-approvals Phase 3 will post the invitation thread
    },
  });
  if (!r.emitted) {
    if (r.error) console.warn(`[needs-attention-route] CEO chat invite FAILED for ${row.id}: ${r.error.message}`);
    return false;
  }
  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: PLATFORM,
    actionKind: "routed_needs_attention",
    specSlug: row.spec_slug,
    reason: `Auto-routed parked ${row.kind} ${row.id.slice(0, 8)} (design_change) → invited CEO to chat.`,
    metadata: { job_id: row.id, action: "chat_invite", target_kind: row.kind, autonomous: true },
  });
  await markRouted(admin, row.id, "design_change");
  return true;
}

/**
 * Phase 4 — backstop sweep. A row older than NEEDS_ATTENTION_STALE_MS still unclassified (the
 * worker classifier didn't reach it / Sonnet was down / migration not yet applied) gets a fresh
 * classification pass; one with class `unknown` after that pass escalates to the CEO with a clear
 * diagnosis (the human-triage path). A row sitting in `needs_attention` past NEEDS_ATTENTION_ALARM_MS
 * also writes a `dashboard_notifications` alarm — the spec's invariant ("zero rows >70 min").
 */
async function routeBackstop(admin: Admin, row: ParkedRow): Promise<{ backstopped: boolean; alarmed: boolean }> {
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  let backstopped = false;
  let alarmed = false;

  // (a) re-classify a row with no class (or with `unknown`) once it's been stale a full hour.
  if (ageMs >= NEEDS_ATTENTION_STALE_MS && (row.needs_attention_class === null || row.needs_attention_class === "unknown")) {
    try {
      const fresh = await classifyAndStamp(admin, row.id, {
        workspaceId: row.workspace_id,
        jobKind: row.kind,
        specSlug: row.spec_slug,
        error: row.error,
        logTail: row.log_tail,
      });
      // If the re-classification still landed unknown, escalate to the CEO — human triage.
      if (fresh.klass === "unknown") {
        await escalateDiagnosisToCeo(admin, {
          workspaceId: row.workspace_id,
          specSlug: row.spec_slug,
          title: `Park needs eyes: ${row.spec_slug ?? row.kind}`,
          diagnosis: `A ${row.kind} job parked >60 min ago and the classifier can't bucket it (no_route_match). Park reason: ${(row.error ?? "(none recorded)").slice(0, 300)}. Log tail: ${(row.log_tail ?? "(none)").slice(-400)}.`,
          dedupeKey: `parkbackstop:${row.id}`,
          deepLink: row.spec_slug ? `/dashboard/roadmap/${row.spec_slug}` : "/dashboard/developer/control-tower",
          escalationKind: "park_backstop",
          metadata: { kind: "needs_attention_backstop", job_id: row.id, target_kind: row.kind },
        });
        await recordDirectorActivity(admin, {
          workspaceId: row.workspace_id,
          directorFunction: PLATFORM,
          actionKind: "routed_needs_attention",
          specSlug: row.spec_slug,
          reason: `Backstop: parked ${row.kind} ${row.id.slice(0, 8)} stayed unknown >60 min — surfaced to CEO.`,
          metadata: { job_id: row.id, action: "backstop_escalation", target_kind: row.kind, autonomous: true },
        });
        backstopped = true;
      }
    } catch (e) {
      console.warn(`[needs-attention-route] backstop classify failed for ${row.id}:`, e instanceof Error ? e.message : e);
    }
  }

  // (b) >70 min still in needs_attention → post the invariant alarm (idempotent per job).
  if (ageMs >= NEEDS_ATTENTION_ALARM_MS) {
    try {
      const { data: existing } = await admin
        .from("dashboard_notifications")
        .select("id")
        .eq("workspace_id", row.workspace_id)
        .eq("metadata->>dedupe_key", `parkalarm:${row.id}`)
        .limit(1);
      if (!existing || !existing.length) {
        const { error } = await admin.from("dashboard_notifications").insert({
          workspace_id: row.workspace_id,
          type: "system",
          title: `Parked > 70 min: ${row.spec_slug ?? row.kind}`,
          body: `A ${row.kind} job has been in needs_attention for more than 70 minutes — the no-parked-specs invariant alarm. Job ${row.id.slice(0, 8)}, class \`${row.needs_attention_class ?? "(none)"}\`. Park reason: ${(row.error ?? "(none recorded)").slice(0, 300)}.`,
          link: row.spec_slug ? `/dashboard/roadmap/${row.spec_slug}` : "/dashboard/developer/control-tower",
          metadata: {
            dedupe_key: `parkalarm:${row.id}`,
            kind: "no_parked_specs_invariant",
            job_id: row.id,
            spec_slug: row.spec_slug,
            target_kind: row.kind,
            class: row.needs_attention_class,
          },
          read: false,
          dismissed: false,
        });
        if (!error) {
          await recordDirectorActivity(admin, {
            workspaceId: row.workspace_id,
            directorFunction: PLATFORM,
            actionKind: "routed_park_alarm",
            specSlug: row.spec_slug,
            reason: `Park alarm: ${row.kind} ${row.id.slice(0, 8)} >70 min in needs_attention — invariant tripped.`,
            metadata: { job_id: row.id, target_kind: row.kind, class: row.needs_attention_class, autonomous: true },
          });
          alarmed = true;
        } else {
          console.warn(`[needs-attention-route] park alarm insert failed for ${row.id}: ${error.message}`);
        }
      }
    } catch (e) {
      console.warn(`[needs-attention-route] park alarm sweep failed for ${row.id}:`, e instanceof Error ? e.message : e);
    }
  }

  return { backstopped, alarmed };
}

/**
 * Auto-resolve a parked NON-SPEC job by DISMISSING it. The job (e.g. `ticket-improve`) doesn't
 * target a spec, so none of the class routers (already_shipped→fold, real_blocker/tooling_failure→
 * child-spec, design_change→CEO chat) can act on it — and the backstop sweep would pointlessly
 * surface a parked ticket co-pilot turn to the CEO and post the 70-min invariant alarm against a
 * non-existent spec. Dismissing is the right terminal: the row leaves the `needs_attention` feed
 * (so the alarm never reaches it) and one CEO click on the activity row reopens it if wrong.
 *
 * Uses the same shape as `applyDismissParkActionInline` in `scripts/builder-worker.ts` — flips
 * status='dismissed' + needs_attention_class='dismissed_by_director' + a `dismissed_park`
 * [[../tables/director_activity]] row — so the activity feed renders consistently with manual
 * dismisses and the existing `POST /api/developer/director-activity/reopen-park` endpoint works
 * unchanged. The director_activity row is also picked up by the ledger so a re-run sees it as
 * settled (belt-and-suspenders against the status filter that already excludes dismissed rows).
 */
async function routeNonSpecJob(admin: Admin, row: ParkedRow): Promise<boolean> {
  const reason = `non-spec job (kind=${row.kind}) has no actionable spec route — auto-dismissing the park instead of escalating to the CEO`;
  const { error } = await admin
    .from("agent_jobs")
    .update({
      status: "dismissed",
      needs_attention_class: "dismissed_by_director",
      error: `dismissed by ${PLATFORM} director: ${reason}`.slice(0, 2000),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "needs_attention"); // re-assert: never dismiss a row that flipped under us
  if (error) {
    console.warn(`[needs-attention-route] non-spec dismiss failed for ${row.id}: ${error.message}`);
    return false;
  }
  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: PLATFORM,
    actionKind: "dismissed_park",
    specSlug: row.spec_slug,
    reason,
    metadata: {
      job_id: row.id,
      spec_slug: row.spec_slug,
      prior_class: row.needs_attention_class,
      target_kind: row.kind,
      auto_applied: true,
      autonomous: true,
      source: "non_spec_kind_router",
    },
  });
  // ALSO write a `routed_needs_attention` ledger row so loadLedger() sees this job as settled on
  // the next pass (the status filter already excludes a dismissed row, but the ledger dedup is the
  // contract the spec calls out — "stamp a director_activity audit row so a re-run never double-routes").
  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: PLATFORM,
    actionKind: "routed_needs_attention",
    specSlug: row.spec_slug,
    reason: `Auto-routed parked ${row.kind} ${row.id.slice(0, 8)} → dismissed (non-spec kind).`,
    metadata: {
      job_id: row.id,
      action: "dismiss_non_spec",
      target_kind: row.kind,
      prior_class: row.needs_attention_class,
      autonomous: true,
    },
  });
  return true;
}

/**
 * The single standing entry: read every NON-OWNED parked row (skipping kinds another lane owns),
 * route each by its class, and run the backstop over the survivors. Dormant until Platform is
 * live + autonomous; bounded per pass; ledger-deduped per job. Returns a one-line summary the
 * standing-pass logger renders.
 */
export async function routeNeedsAttention(admin: Admin): Promise<RouteResult> {
  const empty: RouteResult = { folded: [], spawned: [], chatted: [], backstopped: [], alarmed: [], dismissed: [], scanned: 0 };
  const autonomy = await loadAutonomyMap();
  if (!platformIsAutoApprover(autonomy)) return empty;

  const { data: parked } = await admin
    .from("agent_jobs")
    .select("id, workspace_id, kind, spec_slug, error, log_tail, needs_attention_class, created_at")
    .eq("status", "needs_attention")
    .order("created_at", { ascending: false })
    .limit(500);
  const items = ((parked ?? []) as ParkedRow[]).filter(
    (j) => !SKIP_KINDS.has(j.kind) && !(typeof j.needs_attention_class === "string" && TERMINAL_DIRECTOR_CLASSES.has(j.needs_attention_class)),
  );
  if (!items.length) return empty;

  const ledger = await loadLedger(admin);

  const folded: string[] = [];
  const spawned: string[] = [];
  const chatted: string[] = [];
  const backstopped: string[] = [];
  const alarmed: string[] = [];
  const dismissed: string[] = [];

  for (const row of items) {
    const klass = row.needs_attention_class;
    const isRoutedMarker = typeof klass === "string" && klass.startsWith("routed_");
    const inLedger = ledger.routed.has(row.id);
    const atCap =
      folded.length + spawned.length + chatted.length + backstopped.length + dismissed.length >= PLATFORM_DIRECTOR_ROUTE_CAP;

    // Already routed on a prior pass (the `routed_*` marker) but still parked → it's a zombie the
    // disposition already handled. Clear it terminal and move on — do NOT fall through to the backstop
    // (which would otherwise alarm/re-report it every pass; the appstle-* board loop, 2026-06-26).
    if (isRoutedMarker) {
      await clearRoutedZombie(admin, row);
      continue;
    }

    // NON-SPEC kinds (e.g. ticket-improve) — dismiss the park directly and SKIP both the class
    // dispatch and the backstop sweep. The dismiss is the terminal: the row's status flips to
    // 'dismissed' so the next sweep's status filter excludes it, and (critically) the in-pass
    // backstop never runs against this row so the 70-min invariant alarm cannot fire for a
    // non-spec job sitting >70 min in needs_attention. (ticket-improve-park-auto-route)
    if (!inLedger && !atCap && NON_SPEC_KINDS.has(row.kind)) {
      const ok = await routeNonSpecJob(admin, row);
      if (ok) {
        dismissed.push(row.spec_slug ?? row.id.slice(0, 8));
        continue;
      }
      // If the dismiss write failed, fall through to the normal class/backstop path — better to
      // surface late than to silently drop the row.
    }

    if (!isRoutedMarker && !inLedger && !atCap) {
      let dispatched = false;
      if (klass === "already_shipped") dispatched = (await routeAlreadyShipped(admin, row)) && folded.push(row.spec_slug ?? row.id.slice(0, 8)) > 0;
      else if (klass === "real_blocker" || klass === "tooling_failure") {
        dispatched = (await routeAuthorBlocker(admin, row, klass)) && spawned.push(row.spec_slug ?? row.id.slice(0, 8)) > 0;
      } else if (klass === "design_change") {
        dispatched = (await routeDesignChange(admin, row)) && chatted.push(row.spec_slug ?? row.id.slice(0, 8)) > 0;
      }
      // dispatched falls through to the backstop below for tracking, but each router has already
      // ledger-recorded its decision — the backstop only acts if (a) the row is >60 min unknown or
      // (b) the row is >70 min in needs_attention regardless of class.
      void dispatched;
    }

    const back = await routeBackstop(admin, row);
    if (back.backstopped) backstopped.push(row.spec_slug ?? row.id.slice(0, 8));
    if (back.alarmed && !ledger.alarmed.has(row.id)) alarmed.push(row.spec_slug ?? row.id.slice(0, 8));
  }

  return { folded, spawned, chatted, backstopped, alarmed, dismissed, scanned: items.length };
}
