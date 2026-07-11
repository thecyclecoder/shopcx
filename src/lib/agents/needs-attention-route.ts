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
import { activeParkCardExistsForJob } from "@/lib/agents/approval-inbox";
import { recordDirectorActivity } from "@/lib/director-activity";
import { markSpecCardStatus } from "@/lib/spec-card-state";
import { getSpec } from "@/lib/brain-roadmap";
import { classifyAndStamp, type NeedsAttentionClass } from "@/lib/agents/needs-attention-classify";
import {
  decideCsOwnerRoute,
  applyCsOwnerRoute,
  CS_FUNCTION,
} from "@/lib/agents/needs-attention-route-cs-owner";

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
  /**
   * The JSON payload the enqueue path wrote (per-kind params). Phase 3 of
   * [[../specs/account-linking-address-aware-confidence-graded-and-cs-searchable]] reads
   * `ticket_id` off it to route a CS-owned park (`ticket-handle` / `ticket-analyze`) to the
   * CS Director (June) before Platform's backstop reaches the CEO — see
   * [[needs-attention-route-cs-owner]] `decideCsOwnerRoute`.
   */
  instructions: string | null;
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
 * Authors a child spec THROUGH the `authorSpecRowStructured` chokepoint (a `public.specs` row +
 * `spec_phases`, retire-md-spec-writers-db-is-sole-spec Phase 1 — DB is the spec, never a
 * `docs/brain/specs/{slug}.md` commit). Owner = Platform, parent = the original spec (so the
 * orphan-spec rule holds). Marks **Priority:** critical when the origin was critical.
 *
 * Then writes a `**Blocked-by:** [[{child}]]` flag onto the origin's spec_card_state so the board
 * renders the origin as gated until the child ships. The original WAITS; Vale reviews the newly
 * authored child, and the standing build pipeline picks it up on the next pass (`auto_build`
 * defaults on).
 *
 * Best-effort: a row whose spec is missing falls back to a CEO escalation (the spec a `real_blocker`
 * named couldn't be found → human triage is the right answer).
 */
async function routeAuthorBlocker(admin: Admin, row: ParkedRow, klass: "real_blocker" | "tooling_failure"): Promise<boolean> {
  if (!row.spec_slug) return false;
  const originSpec = await getSpec(row.spec_slug, row.workspace_id);
  if (!originSpec) return false; // backstop will surface to CEO

  const intent =
    klass === "real_blocker"
      ? `The build of [[../specs/${row.spec_slug}]] parked with a real blocker the spec didn't declare. Build the missing prerequisite (API surface, schema change, dependency) INLINE on this branch so the origin can resume.`
      : `The build of [[../specs/${row.spec_slug}]] parked because the ${row.kind} agent's tooling failed to produce a verdict (the pipeline's tooling, not the origin's content). Fix the tool so the origin's build can run cleanly.`;
  const evidence = `Park reason: ${(row.error ?? "(none recorded)").slice(0, 300)}\nLog tail: ${(row.log_tail ?? "(none)").slice(-400)}`;

  // security-review-spec-avalanche fix (2026-07-03) — a build blocker now appends a Fix PHASE to the ORIGIN
  // + resumes its build (fixes-as-phases, [[../pre-merge-fix]]), NOT a standalone `{slug}-fix-blocker-{hash}`
  // child spec. A standalone child built on its OWN branch, drew its OWN fused review, and could park/flag
  // again → a fix-of-fix chain (part of the destructive-migration avalanche). spawnPreMergeFix carries the
  // loop-guard + per-check-key dedup, so a blocker can't spawn an endless run of fix phases either.
  const { spawnPreMergeFix } = await import("@/lib/pre-merge-fix");
  const out = await spawnPreMergeFix(admin, {
    workspaceId: row.workspace_id,
    originSlug: row.spec_slug,
    originTitle: originSpec.card.title ?? row.spec_slug,
    branch: `claude/build-${row.spec_slug}`,
    failing: [
      {
        text: `Build blocker (${klass}) — parked ${row.kind} job ${row.id.slice(0, 8)}. ${intent}\n${evidence}`.slice(0, 2000),
        evidence: (row.error ?? "").slice(0, 300) || null,
        check_key: `blocker:${klass}`,
      },
    ],
  });
  if (!out.spawned && !out.escalated) {
    console.warn(`[needs-attention-route] blocker fix-phase for ${row.spec_slug} not spawned: ${out.reason} — leaving parked for the backstop`);
    return false;
  }

  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: PLATFORM,
    actionKind: "authored_fix",
    specSlug: row.spec_slug,
    reason: `Auto-routed parked ${row.kind} ${row.id.slice(0, 8)} (${klass}) → ${
      out.spawned
        ? `appended a blocker Fix phase to [[${row.spec_slug}]] + resumed its build`
        : `loop-guard escalated (blocker fixes not converging) — held for the owner`
    } (fixes-as-phases; no standalone child spec).`,
    metadata: { job_id: row.id, action: "fix_phase", target_kind: row.kind, klass, routed: "fixes-as-phases", spawn_escalated: out.escalated ?? false, autonomous: true },
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
  // one-card-per-park (DEDUP): if a sibling park surface (the triage "Parked {kind}" card, the >70-min
  // age alarm) already has an active card for this job, don't add a second. One card per parked job. We
  // do NOT markRouted here — that would make this a "routed zombie" the next pass flips to `completed`,
  // which would then auto-clear the SURVIVING sibling card. Leaving the row untouched keeps the single
  // card live; the gate just re-skips each pass (one cheap read) while that card stands.
  if (await activeParkCardExistsForJob(admin, row.workspace_id, row.id)) return false;
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
      // If the re-classification still landed unknown, escalate to the CEO — human triage. one-card-per-park
      // (DEDUP): skip the escalation when a sibling park surface (the triage "Parked {kind}" card emitted by
      // reconcileNeedsAttention, or a prior tick's backstop) already has an active card for this job — one
      // card per parked job. We still re-classified above (cheap + keeps the class fresh); we just don't
      // add a second CEO surface.
      if (fresh.klass === "unknown" && !(await activeParkCardExistsForJob(admin, row.workspace_id, row.id))) {
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

  // (b) >70 min still in needs_attention → post the invariant alarm (idempotent per job). one-card-per-park
  // (DEDUP): only the LEAST-informative surface — skip it entirely when ANY active card already exists for
  // this job (the triage "Parked {kind}" card, the backstop "Park needs eyes", a routed approval). The
  // CEO already has eyes on the job, so the bare age alarm is pure noise; the no-parked-specs invariant is
  // still satisfied (an active card IS the surfacing). Only when NOTHING else surfaced the park does the
  // alarm fire as the backstop-of-last-resort.
  if (ageMs >= NEEDS_ATTENTION_ALARM_MS && !(await activeParkCardExistsForJob(admin, row.workspace_id, row.id))) {
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
 * planner-gates-build-queue-on-authored-specs Phase 2 — true when a still-open plan job in the
 * workspace has this slug in its `pending_actions` (an approved/pending spec proposal that the plan
 * RESUME will author + re-queue). If so the parked `spec_row_missing` build is NOT dismissed: it
 * waits for the plan to land the row + the plan's re-queue takes over. Read-only / best-effort —
 * a DB hiccup falls through to "no open plan owns this slug" so the dismiss path can still run.
 */
async function planJobOwnsSlug(admin: Admin, workspaceId: string, slug: string): Promise<boolean> {
  const OPEN_PLAN_STATUSES = ["queued", "queued_resume", "claimed", "building", "needs_input", "needs_approval", "blocked_on_usage"];
  try {
    const { data, error } = await admin
      .from("agent_jobs")
      .select("pending_actions")
      .eq("workspace_id", workspaceId)
      .eq("kind", "plan")
      .in("status", OPEN_PLAN_STATUSES)
      .limit(50);
    if (error) {
      console.warn(`[needs-attention-route] planJobOwnsSlug lookup failed for ${slug}: ${error.message}`);
      return false;
    }
    for (const row of (data ?? []) as Array<{ pending_actions: unknown }>) {
      const actions = Array.isArray(row.pending_actions) ? (row.pending_actions as Array<{ spec?: { slug?: string } }>) : [];
      for (const a of actions) if (a?.spec?.slug === slug) return true;
    }
    return false;
  } catch (e) {
    console.warn(`[needs-attention-route] planJobOwnsSlug threw for ${slug}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * planner-gates-build-queue-on-authored-specs Phase 2 — auto-dismiss a parked build whose
 * `public.specs` row is missing (the author lane silently failed upstream). The underlying work has
 * no spec to drive it, so the build can never run; the right terminal is to DISMISS the park (the
 * same shape `routeNonSpecJob` uses) so the row leaves `needs_attention` and the 70-min invariant
 * alarm cannot fire against a phantom. Skipped when an OPEN plan job in the workspace still owns
 * the slug in `pending_actions` — the plan RESUME will author the row + re-queue a fresh build, so
 * the parked one just waits (a slightly-noisier inbox is the right cost vs. dismissing the work the
 * plan is about to revive).
 */
async function routeSpecRowMissing(admin: Admin, row: ParkedRow): Promise<"dismissed" | "deferred_plan_owns" | "failed"> {
  if (row.spec_slug) {
    const owned = await planJobOwnsSlug(admin, row.workspace_id, row.spec_slug);
    if (owned) {
      console.log(`[needs-attention-route] spec_row_missing ${row.spec_slug} deferred — open plan job still owns the slug in pending_actions`);
      return "deferred_plan_owns";
    }
  }
  const reason = `spec_row_missing: public.specs has no row for ${row.spec_slug ?? "(no slug)"} and no open plan owns the slug — auto-dismissing the park`;

  // repair-verify-spec-persisted-before-build Phase 2 (backstop) — BEFORE we dismiss the phantom
  // build, ESCALATE: flip the originating repair (matched by `instructions->>'authored_slug' ==
  // row.spec_slug`, compare-and-set on `completed`/`needs_approval`) to needs_attention so
  // `getOpenRepairs` surfaces it on the Control Tower feed, AND stamp a
  // `spec_row_missing_escalated` director_activity row (guaranteed — the helper falls back to a
  // build-scoped stamp when no matching repair exists, so Ada's feed ALWAYS carries a surface
  // signal for this park). Keep 'do not build' — the dismiss still runs; we only replace the
  // silent side of the dismissal with a surfaced escalation. Best-effort + non-throwing so this
  // never wedges the router.
  try {
    const { escalateSpecRowMissingBuild } = await import("@/lib/repair-agent");
    await escalateSpecRowMissingBuild(admin, {
      workspaceId: row.workspace_id,
      buildJobId: row.id,
      slug: row.spec_slug,
      reason,
      source: "parked_router",
    });
  } catch (e) {
    console.warn(`[needs-attention-route] escalateSpecRowMissingBuild threw for ${row.id}:`, e instanceof Error ? e.message : e);
  }

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
    console.warn(`[needs-attention-route] spec_row_missing dismiss failed for ${row.id}: ${error.message}`);
    return "failed";
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
      source: "spec_row_missing_router",
    },
  });
  await recordDirectorActivity(admin, {
    workspaceId: row.workspace_id,
    directorFunction: PLATFORM,
    actionKind: "routed_needs_attention",
    specSlug: row.spec_slug,
    reason: `Auto-routed parked ${row.kind} ${row.id.slice(0, 8)} → dismissed (spec_row_missing).`,
    metadata: {
      job_id: row.id,
      action: "dismiss_spec_row_missing",
      target_kind: row.kind,
      prior_class: row.needs_attention_class,
      autonomous: true,
    },
  });
  return "dismissed";
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
    .select("id, workspace_id, kind, spec_slug, error, log_tail, needs_attention_class, created_at, instructions")
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

    // Phase 3 of account-linking-address-aware-confidence-graded-and-cs-searchable — CS-owned
    // parks (ticket-handle / ticket-analyze — every kind whose registry owner is 'cs') route to
    // the CS Director (June) BEFORE Platform's backstop reaches the CEO. The supervisor-owns-its-
    // layer north-star pattern ([[../operational-rules]]): the owner function rules on its own
    // park; only after CS can't resolve does it fall through to the CEO fail-safe. The decision
    // is pure ([[needs-attention-route-cs-owner]] `decideCsOwnerRoute`); the applier enqueues a
    // `cs-director-call` job for the ticket and stamps a CS-attributed `director_activity` so
    // the approvals-feed renders `raisedBy: cs`, not Platform (Ada).
    if (!inLedger && !atCap) {
      const csDecision = decideCsOwnerRoute(row);
      if (csDecision.route_to === CS_FUNCTION) {
        const outcome = await applyCsOwnerRoute(admin, row, csDecision);
        if (outcome.routed) {
          chatted.push(row.spec_slug ?? row.id.slice(0, 8));
          continue;
        }
        if (outcome.reason === "already_inflight") {
          // June's runner is already ruling; leave the parked row for the next sweep (it will
          // either be terminal by then, or June bounced it back and we can re-enqueue).
          continue;
        }
        // enqueue_failed / no_ticket_id / compare_and_set_lost — fall through to the generic
        // class dispatch + backstop so the row still surfaces somewhere.
      }
    }

    // planner-gates-build-queue-on-authored-specs Phase 2 — a parked build whose `public.specs`
    // row never landed (the planner author lane silently failed upstream). Dismiss the park unless
    // an open plan in the workspace still owns the slug in `pending_actions` (its RESUME will
    // re-queue). SKIP the backstop sweep on the dismiss path so the 70-min alarm cannot fire for
    // a phantom; the deferred-plan-owns path falls through to the backstop (legitimate wait — the
    // alarm IS the right escalation if the plan stays open too long). The class string is written
    // by the worker outside the NeedsAttentionClass enum (it's a sentinel the dispatch-time guard
    // stamps; the heuristic classifier never returns it), so the comparison is against the raw DB
    // value rather than the typed union.
    if ((klass as string | null) === "spec_row_missing" && !inLedger && !atCap) {
      const outcome = await routeSpecRowMissing(admin, row);
      if (outcome === "dismissed") {
        dismissed.push(row.spec_slug ?? row.id.slice(0, 8));
        continue;
      }
      // outcome === "deferred_plan_owns" → fall through to backstop only (no class dispatch).
      // outcome === "failed" → also fall through; the alarm will eventually surface it.
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
