"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { routedInboxHref } from "@/lib/agents/inbox";
import { getPersona, type AgentPersona } from "@/lib/agents/personas";
import { PersonaAvatar } from "@/components/agents/persona-chip";
import { SessionChecklist } from "@/components/agents/session-checklist";
import type { SessionChecklistItem } from "@/lib/agent-jobs";
import { deriveLaneGroupSections } from "@/lib/box-lane-group-sections";

// Live build-box view (build-box-status-view): box health + SHA, lane grid (what each lane is building
// right now), queue depth, and a paused callout. Polls /api/roadmap/box every ~5s — phone-friendly,
// read-only (pausing/killing lanes is the CLI's job, see docs/brain/recipes/manage-the-build-queue).

const REPO = "thecyclecoder/shopcx";
const STALE_MS = 30_000; // a heartbeat older than this ⇒ box stale/down (worker ticks ~5s)

interface LaneRow {
  kind: string;
  job_id: string;
  spec_slug: string;
  since: string;
  phase?: string | null; // "Phase N" for a chained/per-phase build, else null (box-lane-show-phase)
  intent?: string | null; // director-coach lanes only: "ask" | "coach" (the CEO's button) — for the label
  // box-grading-session-and-account-count-fixes Phase 3: the ACTING director's function slug for a
  // grade/coach lane (platform→Ada, ceo→Henry, growth→Cleo), so the card shows "Ada Grading" / "Henry
  // Grading" instead of a generic label + default mascot. Enriched by /api/roadmap/box from the job.
  director_function?: string | null;
  account?: string | null; // which Round Robin Max account this lane is running on (box-lane-show-account)
  // box-session-transparency Phase 2: the lane's live TodoWrite mirror — what its `claude -p` session is
  // doing right now. session_note = the compact one-line verb shown on the lane card; session_checklist =
  // the full plan, expand to see. Written by the shared `runBoxSession` runner, enriched into the lane by
  // /api/roadmap/box. Null on a session that hasn't yet emitted a TodoWrite (or a pre-Phase-1 row).
  session_note?: string | null;
  session_checklist?: SessionChecklistItem[] | null;
  // consolidate-premerge-checks-one-session Phase 2 — true for a `spec-test` lane whose underlying job's
  // `spec_branch` is a `claude/*` PR branch (fused pre-merge session emits BOTH the spec-test verdict AND
  // the security verdict in one JSON). The card renders TWO avatars (Vera + Vault) + a 'spec-test ·
  // security' label; a post-ship spec-test lane (no branch) still renders single-persona.
  fused_pre_merge?: boolean;
  // chained-phase-session-resume Phase 2 — true when this lane's job started as a RESUME of a prior
  // claude -p session (chained-phase carry-forward, or a mid-run queued_resume flip = cache-warm), false
  // when it started FRESH (cache-cold). The card renders a small `resumed`/`fresh` chip on build lanes
  // so a silent regression (resume quietly not firing) is visible mid-chain. Undefined on legacy rows
  // (a pre-Phase-2 heartbeat) — the chip is skipped so nothing regresses.
  resumed?: boolean;
}
interface AccountSlot {
  label: string;
  in_flight: number;
  capped: boolean;
  capped_until: string | null;
}
interface AccountEvent {
  at: string;
  type: string; // cap | failover | all_capped | recovered
  account: string;
  detail: string;
}
// Per-account Max load + cap/failover events (box-multi-account-failover Phase 2). null on a single-account box.
interface AccountsSnapshot {
  pool: AccountSlot[];
  healthy: number;
  total: number;
  all_capped: boolean;
  soonest_reset: string | null;
  events: AccountEvent[];
  codex?: AccountSlot | null; // the second runtime (box-codex-runner) — null when Codex is disabled
}
// build-box-page-reflects-real-per-lane-group-usage Phase 2 — per-group cap map from the heartbeat.
// The page renders each named group as its own LaneRowGrid, filtered by the group's kind-set against
// the group's cap. Null on legacy heartbeat rows (the page then falls back to the old build_lanes /
// fold_lanes single-pool render).
interface LaneGroups {
  [group: string]: { cap: number; kinds: string[] };
}
interface Worker {
  running_sha: string | null;
  status: string;
  active_builds: number;
  detail: string | null;
  last_poll_at: string | null;
  started_at: string | null;
  build_lanes: number;
  fold_lanes: number;
  lane_groups: LaneGroups | null;
  lanes: LaneRow[];
  accounts: AccountsSnapshot | null;
}
interface Job {
  id: string;
  spec_slug: string;
  kind: string;
  status: string;
  pr_url: string | null;
  pr_number: number | null;
  created_at: string;
  phase?: string | null; // queued-jobs-log: "Phase N" (from instructions, or the spec's next-unshipped phase)
  spec_missing?: boolean; // fold-guard-live-build: the spec page would 404 (folded/archived/deleted)
  director_function?: string | null; // box-grading-session-and-account-count-fixes Phase 3 (grade/coach kinds)
  fused_pre_merge?: boolean; // consolidate-premerge-checks-one-session Phase 2 (queued fused pre-merge spec-test)
}
interface FailedJob {
  id: string;
  spec_slug: string;
  kind: string;
  error: string | null;
  detail: string | null;
  updated_at: string;
  spec_missing?: boolean; // fold-guard-live-build: the spec page would 404 (folded/archived/deleted)
}

// preview-test-promote-pipeline M1 Phase 3 — the Vercel Ignored-Build-Step override state. Surfaced
// here so the supervisor can SEE that `claude/*` preview builds are enabled. enabled: the live Vercel
// command matches `CLAUDE_PREVIEW_IGNORE_COMMAND`; drifted: a different command is set (run the
// apply script); unknown: token absent or fetch failed (chip stays neutral, not a red).
interface PreviewBuildOverride {
  status: "enabled" | "drifted" | "unknown";
  expected: string;
  actual: string | null;
  reason: string | null;
  fetched_at: string | null;
}

// build-box-page-reflects-real-per-lane-group-usage Phase 3 + build-box-page-other-lanes-truthful-
// capacity-not-summed-caps Phase 1 — display order, labels, and the pool-vs-supervisory-bucket
// distinction now live in the pure derivation helper `deriveLaneGroupSections` (src/lib/
// box-lane-group-sections.ts). Real concurrent pools (build/plan 10, CS 5, director 2, fold 1)
// keep their cap; the `other` supervisory bucket carries cap=null so LaneRowGrid renders it as
// an active-count only — no phantom /35 denominator, no phantom open cells.

// Route a FAILED job to where you'd look at / rebuild it (a failure isn't an approval — see the paused
// section below, which routes to the routed inbox). SAFE-BY-DEFAULT (a NEW agent kind can never 404 here):
// only kinds whose `spec_slug` is a REAL spec/goal — or that have a dedicated surface — get a deep link;
// EVERY other kind (repair, db_health, coverage-register, triage, and any future agent) defaults to the
// Agents inbox (approval-routing-engine Phase 4 — never the 404-prone `/dashboard/roadmap/{slug}`, never a
// scattered Control Tower feed). The Control Tower default was retired with the standalone approval cards.
const SPEC_SLUG_KINDS = new Set(["build", "spec-test"]); // slug = docs/brain/specs/{slug}.md
function failedHref(kind: string, specSlug: string, specMissing?: boolean): string {
  if (kind === "plan") return `/dashboard/roadmap/goals/${specSlug}`;
  if (kind === "migration-fix") return "/dashboard/migrations";
  // storefront-optimizer slug is a surface key (product:lander:audience) → the optimizer dashboard.
  if (kind === "storefront-optimizer") return "/dashboard/storefront/optimizer";
  // A real-spec job: the spec page, or the board if the spec was folded/archived (never a dead link).
  if (SPEC_SLUG_KINDS.has(kind)) return specMissing ? "/dashboard/roadmap" : `/dashboard/roadmap/${specSlug}`;
  // DEFAULT — every agent-proposal kind: the routed Agents inbox (single source), never the Control Tower.
  return routedInboxHref();
}

function workerStale(w: Worker): boolean {
  if (!w.last_poll_at) return true;
  return Date.now() - new Date(w.last_poll_at).getTime() > STALE_MS;
}

// Compact duration ("Ns/Nm/Nh/Nd") from a second count.
function fmtDur(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}
// Elapsed since a PAST timestamp (e.g. an event time).
function elapsed(iso: string): string {
  return fmtDur((Date.now() - new Date(iso).getTime()) / 1000);
}
// Time UNTIL a FUTURE timestamp (e.g. a cap reset). Using elapsed() here was the "resets ~0s away" bug —
// a future time minus now is negative, which clamps to 0; this is the correctly-signed direction.
function until(iso: string): string {
  return fmtDur((new Date(iso).getTime() - Date.now()) / 1000);
}
// Reset times are shown in AST (America/Puerto_Rico, UTC-4, no DST) — the CEO's local time — not UTC.
function astTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Puerto_Rico", hour: "numeric", minute: "2-digit" }) + " AST";
}

const KIND_CHIP: Record<string, string> = {
  build: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300",
  plan: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300",
  fold: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300",
  "spec-test": "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300",
  "pr-resolve": "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  repair: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  regression: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300",
  "migration-fix": "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300",
  "director-coach": "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
  "product-seed": "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
};

// What each agent is *doing* — a short present-tense verb shown under its name (box-lane readability).
const KIND_ACTION: Record<string, string> = {
  build: "building",
  plan: "planning",
  fold: "folding into the brain",
  "spec-test": "QA-verifying",
  "pr-resolve": "resolving conflicts on",
  repair: "diagnosing",
  regression: "reviewing regression in",
  "migration-fix": "repairing migration for",
  "director-coach": "coaching on",
  "platform-director": "standing pass",
  "triage-escalations": "triaging",
  "product-seed": "seeding",
  "spec-chat": "speccing",
  "dev-ask": "investigating",
  db_health: "tuning the DB for",
  "coverage-register": "registering coverage for",
  "storefront-optimizer": "optimizing",
  "ticket-improve": "improving ticket",
};

// box-grading-session-and-account-count-fixes Phase 3: the grade/coach lanes are a DIRECTOR supervising —
// show that director (dynamic), not a generic 'Agent Grade' + default mascot. `director_function` is carried
// on the job by the enqueue + surfaced by /api/roadmap/box; the verb is the supervisory action. Falls back
// to platform/Ada (today's platform-worker grading) when the field is absent.
const GRADE_COACH_VERB: Record<string, string> = {
  "agent-grade": "Grading",
  "agent-coach": "Coaching",
  "director-grade": "Grading",
  "campaign-grade": "Grading",
  "gap-grade": "Grading",
};
// Fallback acting-director function per kind when the job didn't carry `director_function`.
const GRADE_COACH_DEFAULT_FN: Record<string, string> = {
  "agent-grade": "platform", // Ada grades platform workers
  "agent-coach": "platform",
  "director-grade": "ceo", // the CEO (Henry) grades directors
  "campaign-grade": "growth", // Cleo grades storefront campaigns
  "gap-grade": "growth", // Cleo grades acquisition gaps
};
/** For a grade/coach kind → the acting director's persona + verb ("Ada Grading"); null for any other kind. */
function gradeCoachInfo(kind: string, directorFunction?: string | null): { persona: AgentPersona; verb: string } | null {
  const verb = GRADE_COACH_VERB[kind];
  if (!verb) return null;
  const fn = (directorFunction && directorFunction.trim()) || GRADE_COACH_DEFAULT_FN[kind] || "platform";
  return { persona: getPersona(fn), verb };
}

// The director kinds embody Ada (the Platform director) — her persona + avatar, not a generic label.
function personaForKind(kind: string, directorFunction?: string | null) {
  const gc = gradeCoachInfo(kind, directorFunction);
  if (gc) return gc.persona;
  return kind === "platform-director" || kind === "director-coach" ? getPersona("platform") : getPersona(kind);
}

// consolidate-premerge-checks-one-session Phase 2 — for a fused pre-merge spec-test lane the SAME session
// emits BOTH verdicts (spec-test + security) off the same loaded branch diff, so the card renders both
// personas + a static dual label. The label is static because the fused session is Codex-primary and Codex
// has no TodoWrite, so we can't lean on the live session_checklist to pick the active sub-task; the card
// must render correctly with an empty checklist. A non-fused spec-test lane (post-ship / no branch) resolves
// to null and the caller falls back to the single-persona path.
function fusedPreMergeInfo(
  kind: string,
  fusedPreMerge?: boolean,
): { personas: [AgentPersona, AgentPersona]; title: string; label: string } | null {
  if (kind !== "spec-test" || !fusedPreMerge) return null;
  return {
    personas: [getPersona("spec-test"), getPersona("security-review")],
    title: "Vera → Vault · pre-merge check",
    label: "spec-test · security",
  };
}

function LaneCell({ lane }: { lane: LaneRow | null }) {
  if (!lane) {
    return (
      <div className="flex min-h-[88px] flex-col items-center justify-center rounded-lg border border-dashed border-zinc-200 text-xs text-zinc-400 dark:border-zinc-800">
        open
      </div>
    );
  }
  // A director-coach lane is the CEO talking to Ada — show the SUBJECT (Ada)'s avatar + an Asking/Coaching
  // label by the button the CEO pushed (intent), and hide the meaningless thread-id slug.
  const isCoach = lane.kind === "director-coach";
  const persona = personaForKind(lane.kind, lane.director_function);
  const gc = gradeCoachInfo(lane.kind, lane.director_function); // grade/coach kinds → "Ada Grading" etc.
  // A fused pre-merge lane (spec-test job on a claude/* branch) is ONE session emitting BOTH verdicts, so
  // it renders both personas + a dual title / static sub-task label. Non-fused lanes are unchanged.
  const fused = fusedPreMergeInfo(lane.kind, lane.fused_pre_merge);
  const title = fused
    ? fused.title
    : isCoach
      ? (lane.intent === "coach" ? `Coaching ${persona.name}` : `Asking ${persona.name}`)
      : gc
        ? `${persona.name} ${gc.verb}`
        : persona.name;
  const action = isCoach ? "with the CEO" : KIND_ACTION[lane.kind] ?? "working on";
  return (
    <div className="flex min-h-[88px] flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {/* Row 1: avatar + name (full width — no longer truncated by the chips) + elapsed time. A fused
          pre-merge lane shows BOTH avatars (Vera + Vault) side-by-side; every other lane keeps its single
          avatar. */}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {fused ? (
            <span className="flex shrink-0 items-center -space-x-2">
              <PersonaAvatar persona={fused.personas[0]} size={20} />
              <PersonaAvatar persona={fused.personas[1]} size={20} />
            </span>
          ) : (
            <PersonaAvatar persona={persona} size={20} />
          )}
          <span className="truncate text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</span>
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{elapsed(lane.since)}</span>
      </div>
      {/* Row 2: the kind chip + the Round Robin account, indented under the name (off the cramped header).
          A fused pre-merge lane appends a static 'spec-test · security' sub-task label so the card reads
          correctly with NO session_checklist (Codex has no TodoWrite). */}
      <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[26px]">
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${KIND_CHIP[lane.kind] || KIND_CHIP.build}`}>{lane.kind}</span>
        {fused && (
          <span className="shrink-0 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
            {fused.label}
          </span>
        )}
        {lane.account && (
          <span title={`Running on ${lane.account}`} className="shrink-0 rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {lane.account}
          </span>
        )}
        {/* chained-phase-session-resume Phase 2 — the resumed-vs-fresh indicator per BUILD lane so a
            silent regression (resume quietly not firing) is visible mid-chain. Emerald when RESUMED
            (cache-warm: prior transcript served from cache ~0.1x); zinc when FRESH (cache-cold). Only
            renders on build lanes and when the field is defined (undefined = legacy heartbeat = silent). */}
        {lane.kind === "build" && typeof lane.resumed === "boolean" && (
          <span
            title={
              lane.resumed
                ? "Resumed the prior phase's claude session — its transcript is served from prompt cache (~0.1x) instead of re-hydrated"
                : "Started this phase's claude session fresh — spec + branch re-hydrated at full price"
            }
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              lane.resumed
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            }`}
          >
            {lane.resumed ? "resumed" : "fresh"}
          </span>
        )}
      </div>
      {isCoach ? (
        <span className="block text-[11px] text-zinc-400">{action}</span>
      ) : (
        <Link
          href={`/dashboard/roadmap/${lane.spec_slug}`}
          className="group block min-w-0"
          title={lane.phase ? `${lane.spec_slug} · ${lane.phase}` : lane.spec_slug}
        >
          <span className="block text-[11px] text-zinc-400">{action}</span>
          <span className="block truncate text-[12px] font-medium text-zinc-700 group-hover:text-indigo-600 dark:text-zinc-200 dark:group-hover:text-indigo-400">
            {lane.spec_slug}
          </span>
          {lane.phase && (
            <span className="block truncate text-[11px] text-zinc-400 dark:text-zinc-500">{lane.phase}</span>
          )}
        </Link>
      )}
      {/* box-session-transparency Phase 2 — the lane's live TodoWrite mirror: a one-line current-step
          verb + expand for the full checklist. Renders nothing until the runner streams its first
          TodoWrite onto the row, so a freshly-claimed lane still reads cleanly. */}
      <SessionChecklist note={lane.session_note} checklist={lane.session_checklist} density="lane" />
    </div>
  );
}

const EVENT_CHIP: Record<string, string> = {
  cap: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
  all_capped: "bg-rose-200 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200",
  failover: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  recovered: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
};

// Per-account Max load + cap/failover events (box-multi-account-failover Phase 2): show how each account's
// 5-hour quota is burning, an all-accounts-capped banner (builds parked, auto-resume — not a failure), and
// the recent cap/failover/recovery breadcrumbs so a silent "everything's capped" is visible.
function AccountsPanel({ accounts }: { accounts: AccountsSnapshot }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Max accounts</h3>
        <span className="text-xs tabular-nums text-zinc-400">
          {accounts.healthy}/{accounts.total} healthy
        </span>
      </div>

      {accounts.all_capped && (
        <div className="mb-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-900/40 dark:bg-rose-900/20 dark:text-rose-300">
          ⚠ All Max accounts capped — builds parked (<code>blocked_on_usage</code>) and auto-resume
          {accounts.soonest_reset ? ` at ${astTime(accounts.soonest_reset)} (~${until(accounts.soonest_reset)})` : ""}. No manual rebuild needed.
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
        {accounts.pool.map((a) => (
          <div
            key={a.label}
            className={`flex flex-col gap-1 rounded-lg border p-2.5 text-xs shadow-sm ${
              a.capped
                ? "border-rose-200 bg-rose-50 dark:border-rose-900/40 dark:bg-rose-900/20"
                : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">{a.label}</span>
              <span
                className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  a.capped
                    ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
                    : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                }`}
              >
                {a.capped ? "capped" : "healthy"}
              </span>
            </div>
            <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
              {a.in_flight} in flight
              {a.capped && a.capped_until ? ` · resets ${astTime(a.capped_until)} (~${until(a.capped_until)})` : ""}
            </span>
          </div>
        ))}

        {/* The second runtime (box-codex-runner): a Codex runner card alongside the Max accounts. Indigo
            accent so it reads as a distinct runtime, not a Max account; rose when its ChatGPT-plan wall is hit. */}
        {accounts.codex && (
          <div
            className={`flex flex-col gap-1 rounded-lg border p-2.5 text-xs shadow-sm ${
              accounts.codex.capped
                ? "border-rose-200 bg-rose-50 dark:border-rose-900/40 dark:bg-rose-900/20"
                : "border-indigo-200 bg-indigo-50/60 dark:border-indigo-900/40 dark:bg-indigo-900/15"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-zinc-700 dark:text-zinc-200">
                Codex <span className="text-[10px] font-normal text-indigo-500 dark:text-indigo-400">ChatGPT plan</span>
              </span>
              <span
                className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  accounts.codex.capped
                    ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
                    : "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300"
                }`}
              >
                {accounts.codex.capped ? "capped" : "healthy"}
              </span>
            </div>
            <span className="tabular-nums text-zinc-500 dark:text-zinc-400">
              {accounts.codex.in_flight} in flight
              {accounts.codex.capped && accounts.codex.capped_until
                ? ` · Claude fallback until ${astTime(accounts.codex.capped_until)} (~${until(accounts.codex.capped_until)})`
                : ""}
            </span>
          </div>
        )}
      </div>

      {accounts.events.length > 0 && (
        <ul className="mt-2 space-y-1">
          {accounts.events.slice(0, 6).map((e, i) => (
            <li key={`${e.at}-${i}`} className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span className="tabular-nums text-zinc-400">{elapsed(e.at)} ago</span>
              <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${EVENT_CHIP[e.type] || EVENT_CHIP.failover}`}>
                {e.type.replace("_", " ")}
              </span>
              <span className="text-zinc-600 dark:text-zinc-300">{e.account}</span>
              <span className="truncate">— {e.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LaneRowGrid({ label, total, lanes }: { label: string; total: number | null; lanes: LaneRow[] }) {
  // build-box-page-other-lanes-truthful-capacity-not-summed-caps Phase 1 — total=null is the
  // truthful supervisory-bucket display for the 'other' group. Its per-kind caps (spec-test 3 +
  // agent-grade 1 + … ~ 35) never co-run at the summed ceiling, so a "4/35 in use" render is a
  // phantom denominator. Render just the ACTIVE count with no open cells; the empty state reads
  // as "no supervisory agents running" instead of ~30 fake empty slots. Real concurrent pools
  // (build/plan, CS, director, fold) still render against their cap unchanged.
  if (total === null) {
    return (
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</h3>
          <span className="text-xs tabular-nums text-zinc-400">{lanes.length} active</span>
        </div>
        {lanes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-200 py-4 text-center text-xs text-zinc-400 dark:border-zinc-800">
            No supervisory agents running
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            {lanes.map((c) => (
              <LaneCell key={c.job_id} lane={c} />
            ))}
          </div>
        )}
      </div>
    );
  }
  // Fill the first cells with in-use lanes, the rest render "open".
  const cells: (LaneRow | null)[] = Array.from({ length: total }, (_, i) => lanes[i] ?? null);
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</h3>
        <span className="text-xs tabular-nums text-zinc-400">
          {lanes.length}/{total} in use
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        {cells.map((c, i) => (
          <LaneCell key={c?.job_id ?? `open-${i}`} lane={c} />
        ))}
      </div>
    </div>
  );
}

// "Jobs in queue" — a compact log/feed of jobs WAITING to be claimed (queued / queued_resume), oldest
// first (next up). One row per job with the agent's PROFILE PHOTO (kind→persona, the same resolver the
// active lanes use), the agent name, the kind chip, the spec slug, and the derived "Phase N" — so the CEO
// can see what's lined up behind the active builds, with faces. Read-only, visually consistent with the
// lane cards above (queued-jobs-log).
function QueuedJobsLog({ jobs }: { jobs: Job[] }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Jobs in queue</h3>
        <span className="text-xs tabular-nums text-zinc-400">{jobs.length} waiting</span>
      </div>
      {jobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-6 text-center text-xs text-zinc-400 dark:border-zinc-800">
          No jobs queued
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {jobs.map((j) => {
            const persona = personaForKind(j.kind, j.director_function);
            const gc = gradeCoachInfo(j.kind, j.director_function); // grade/coach kinds → "Ada Grading" etc.
            // A queued fused pre-merge spec-test renders both personas + a dual title, same as the
            // in-flight lane treatment (consolidate-premerge-checks-one-session Phase 2).
            const fused = fusedPreMergeInfo(j.kind, j.fused_pre_merge);
            // A queued job's slug is only a real spec page for the spec-slug kinds (and not if it was folded).
            const slugIsLink = SPEC_SLUG_KINDS.has(j.kind) && !j.spec_missing;
            return (
              <li key={j.id} className="flex items-center gap-2.5 px-3 py-2">
                {fused ? (
                  <span className="flex shrink-0 items-center -space-x-2">
                    <PersonaAvatar persona={fused.personas[0]} size={20} />
                    <PersonaAvatar persona={fused.personas[1]} size={20} />
                  </span>
                ) : (
                  <PersonaAvatar persona={persona} size={20} />
                )}
                <span className="shrink-0 text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{fused ? fused.title : gc ? `${persona.name} ${gc.verb}` : persona.name}</span>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${KIND_CHIP[j.kind] || KIND_CHIP.build}`}>
                  {j.kind}
                </span>
                {fused && (
                  <span className="shrink-0 rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300">
                    {fused.label}
                  </span>
                )}
                {slugIsLink ? (
                  <Link
                    href={`/dashboard/roadmap/${j.spec_slug}`}
                    className="min-w-0 truncate text-[12px] font-medium text-zinc-700 hover:text-indigo-600 dark:text-zinc-200 dark:hover:text-indigo-400"
                    title={j.spec_slug}
                  >
                    {j.spec_slug}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-[12px] font-medium text-zinc-600 dark:text-zinc-300" title={j.spec_slug}>
                    {j.spec_slug}
                  </span>
                )}
                {j.spec_missing && <span className="shrink-0 text-[10px] text-zinc-400">(spec archived)</span>}
                {j.phase && <span className="shrink-0 text-[11px] text-zinc-400 dark:text-zinc-500">{j.phase}</span>}
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-400">{elapsed(j.created_at)} ago</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function BoxPage() {
  const workspace = useWorkspace();
  const [worker, setWorker] = useState<Worker | null>(null);
  const [queue, setQueue] = useState<Job[]>([]);
  const [paused, setPaused] = useState<Job[]>([]);
  const [failed, setFailed] = useState<FailedJob[]>([]);
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  // box-failed-build-supersede-and-dismiss Phase 2 — per-jobId busy flag for the Dismiss button so
  // a double-click doesn't fire two writes and the card can still be interacted with while another
  // failed card is dismissing.
  const [dismissing, setDismissing] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [drain, setDrain] = useState<{ draining: boolean; requested_by: string | null } | null>(null);
  const [drainBusy, setDrainBusy] = useState(false);
  const [previewOverride, setPreviewOverride] = useState<PreviewBuildOverride | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/roadmap/box")
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          setWorker(d.worker ?? null);
          setQueue(d.queue ?? []);
          setPaused(d.paused ?? []);
          setFailed(d.failed ?? []);
          setDrain(d.drain ?? null);
          setPreviewOverride(d.preview_build_override ?? null);
        })
        .catch(() => {})
        .finally(() => alive && setLoading(false));
    load();
    const interval = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  const retry = async (slug: string) => {
    setRetrying((r) => ({ ...r, [slug]: true }));
    try {
      const res = await fetch("/api/roadmap/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (res.ok) setFailed((f) => f.filter((j) => j.spec_slug !== slug)); // optimistic — it's re-queued now
    } catch {
      /* leave it; the next poll reflects real state */
    } finally {
      setRetrying((r) => ({ ...r, [slug]: false }));
    }
  };

  // box-failed-build-supersede-and-dismiss Phase 2 — clear a stuck failed card without a manual DB
  // edit. Flips the target agent_jobs row to `completed` (see /api/roadmap/box/dismiss-failed); on
  // success we drop it from the local `failed` array optimistically so the card disappears without
  // waiting for the 5s poll.
  const dismiss = async (jobId: string) => {
    setDismissing((d) => ({ ...d, [jobId]: true }));
    try {
      const res = await fetch("/api/roadmap/box/dismiss-failed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      if (res.ok) setFailed((f) => f.filter((j) => j.id !== jobId));
    } catch {
      /* next poll reflects real state */
    } finally {
      setDismissing((d) => ({ ...d, [jobId]: false }));
    }
  };

  const toggleDrain = async (next: boolean) => {
    setDrainBusy(true);
    setDrain((d) => ({ draining: next, requested_by: d?.requested_by ?? null })); // optimistic
    try {
      await fetch("/api/roadmap/box/drain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drain: next }),
      });
    } catch {
      /* next poll reflects real state */
    } finally {
      setDrainBusy(false);
    }
  };

  if (workspace.role !== "owner") {
    return (
      <div className="p-6">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Build box</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">This view is owner-only.</p>
      </div>
    );
  }

  const stale = worker ? workerStale(worker) : true;
  // build-box-page-reflects-real-per-lane-group-usage Phase 3 + build-box-page-other-lanes-
  // truthful-capacity-not-summed-caps Phase 1 — the pure derivation in `deriveLaneGroupSections`
  // filters each lane group's rows by its kind-set AND collapses the 'other' supervisory bucket's
  // summed-caps to a null cap (LaneRowGrid then renders "N active" — no phantom /35 denominator,
  // no phantom open cells). Real concurrent pools (build/plan, CS, director, fold) keep their
  // cap unchanged. When lane_groups is null (a legacy heartbeat row) the helper returns null and
  // the page falls back to the old single-pool render so nothing regresses on an old box.
  const laneGroupSections = deriveLaneGroupSections<LaneRow>(worker?.lane_groups, worker?.lanes);
  const buildLanes = (worker?.lanes ?? []).filter((l) => l.kind !== "fold");
  const foldLanes = (worker?.lanes ?? []).filter((l) => l.kind === "fold");

  return (
    <div className="mx-auto w-full max-w-screen-xl p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Build box</h1>
        <div className="flex items-center gap-3">
          {drain && (
            <button
              onClick={() => void toggleDrain(!drain.draining)}
              disabled={drainBusy}
              title={drain.draining ? "Cancel the drain — resume claiming builds now" : "Pause new builds so in-flight lanes finish, the box goes idle and self-updates (SHA advances), then claiming resumes"}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
                drain.draining
                  ? "bg-amber-500 text-white hover:bg-amber-600"
                  : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              }`}
            >
              {drain.draining ? "Cancel queue restart" : "Queue restart"}
            </button>
          )}
          <Link href="/dashboard/roadmap" className="text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200">
            ← Roadmap
          </Link>
        </div>
      </div>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Live view of the self-hosted build worker — health, lanes, and what each lane is building right now. Read-only;
        pausing or killing lanes is a CLI job. Polls every ~5s.
      </p>

      {drain?.draining && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-300">
          ⏳ Queue restart staged{drain.requested_by ? ` by ${drain.requested_by}` : ""} — new builds are queuing; the box
          finishes in-flight lanes, goes idle, self-updates (SHA advances), then resumes. {worker?.active_builds ? `${worker.active_builds} lane(s) still draining.` : "Idle — updating shortly."}
        </div>
      )}

      {loading && !worker ? (
        <div className="py-12 text-center text-sm text-zinc-400">Loading…</div>
      ) : !worker ? (
        <div className="rounded-lg border border-dashed border-zinc-200 py-12 text-center text-sm text-zinc-400 dark:border-zinc-800">
          No heartbeat yet — the box hasn&apos;t reported in.
        </div>
      ) : (
        <>
          {/* Health header */}
          <div
            className={`mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-sm ${
              stale
                ? "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-900/20 dark:text-rose-300"
                : "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-900/20 dark:text-emerald-300"
            }`}
          >
            <span className="font-semibold">{stale ? "⚠ stale" : "● healthy"}</span>
            <span>·</span>
            <span>
              SHA{" "}
              {worker.running_sha ? (
                <a
                  href={`https://github.com/${REPO}/commit/${worker.running_sha}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono underline decoration-dotted underline-offset-2"
                >
                  {worker.running_sha}
                </a>
              ) : (
                <code className="font-mono">?</code>
              )}
            </span>
            <span>·</span>
            <span>uptime {worker.started_at ? elapsed(worker.started_at) : "?"}</span>
            <span>·</span>
            <span>last poll {worker.last_poll_at ? `${elapsed(worker.last_poll_at)} ago` : "never"}</span>
            {worker.status !== "healthy" && <span className="opacity-80">· {worker.status}</span>}
            {worker.detail && <span className="opacity-80">· {worker.detail}</span>}
          </div>

          {/* preview-test-promote-pipeline M1 Phase 3 — Vercel Ignored-Build-Step override state.
              A live chip showing whether `claude/*` build branches produce a preview deploy. The
              supervisor sees the override is in place without running the apply script. The actual
              command is the tooltip — see + pause the tool (supervisable autonomy). */}
          {previewOverride && (
            <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span
                title={previewOverride.actual ?? previewOverride.reason ?? "Run scripts/apply-vercel-ignore-step-override.ts to set"}
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  previewOverride.status === "enabled"
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                    : previewOverride.status === "drifted"
                    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                    : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                }`}
              >
                <span aria-hidden>{previewOverride.status === "enabled" ? "●" : previewOverride.status === "drifted" ? "⚠" : "○"}</span>
                {previewOverride.status === "enabled" && "Vercel preview builds: enabled for claude/*"}
                {previewOverride.status === "drifted" && "Vercel preview builds: drifted — re-apply override"}
                {previewOverride.status === "unknown" && `Vercel preview builds: unknown${previewOverride.reason ? ` (${previewOverride.reason})` : ""}`}
              </span>
              {previewOverride.fetched_at && (
                <span className="tabular-nums text-zinc-400">checked {elapsed(previewOverride.fetched_at)} ago</span>
              )}
            </div>
          )}

          {/* Lane grid + per-account Max load */}
          <div className="space-y-5">
            {worker.accounts && <AccountsPanel accounts={worker.accounts} />}
            {laneGroupSections ? (
              // build-box-page-reflects-real-per-lane-group-usage Phase 3 + build-box-page-other-
              // lanes-truthful-capacity-not-summed-caps Phase 1 — one LaneRowGrid per lane group.
              // Real pools render against their own cap; the supervisory bucket (cap=null) always
              // renders (its "N active" tally is meaningful even at zero — an empty-state chip).
              laneGroupSections.map((section) =>
                section.cap === null || section.cap > 0 || section.lanes.length > 0 ? (
                  <LaneRowGrid key={section.key} label={section.label} total={section.cap} lanes={section.lanes} />
                ) : null,
              )
            ) : (
              // Legacy fallback for a heartbeat row written before lane_groups existed — same single-
              // pool render as before, no regression on an older box.
              <>
                <LaneRowGrid label="Build / plan lanes" total={worker.build_lanes} lanes={buildLanes} />
                <LaneRowGrid label="Fold lane" total={worker.fold_lanes} lanes={foldLanes} />
              </>
            )}
          </div>

          {/* Jobs in queue — a faces-attached log of what's lined up behind the active lanes (queued-jobs-log) */}
          <div className="mt-5">
            <QueuedJobsLog jobs={queue} />
          </div>

          {/* Failed builds — surface the failure + the real reason (529 / Max / tsc) + a one-tap retry */}
          {failed.length > 0 && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm dark:border-red-900/40 dark:bg-red-900/20">
              <p className="mb-2 font-medium text-red-800 dark:text-red-300">
                {failed.length} build{failed.length === 1 ? "" : "s"} failed
              </p>
              <ul className="space-y-2.5">
                {failed.map((j) => (
                  <li key={j.id} className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={failedHref(j.kind, j.spec_slug, j.spec_missing)}
                        className="font-medium text-red-800 underline decoration-dotted underline-offset-2 hover:text-red-900 dark:text-red-300 dark:hover:text-red-200"
                      >
                        {j.spec_slug}
                      </Link>
                      {j.spec_missing && <span className="text-[10px] text-red-600/70 dark:text-red-400/70">(spec archived)</span>}
                      <span className="text-xs text-red-600/80 dark:text-red-400/80">{j.error ?? "failed"} · {elapsed(j.updated_at)} ago</span>
                      <button
                        onClick={() => retry(j.spec_slug)}
                        disabled={retrying[j.spec_slug]}
                        className="ml-auto inline-flex items-center rounded-md bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        {retrying[j.spec_slug] ? "Retrying…" : "↻ Retry build"}
                      </button>
                      {/* box-failed-build-supersede-and-dismiss Phase 2 — one-tap Dismiss so a ghost
                          card can be cleared without a manual DB edit. Flips the row to `completed`
                          (see POST /api/roadmap/box/dismiss-failed), owner-gated. */}
                      <button
                        onClick={() => dismiss(j.id)}
                        disabled={dismissing[j.id]}
                        className="inline-flex items-center rounded-md border border-red-300 bg-white/70 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-900/60 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-900/30"
                      >
                        {dismissing[j.id] ? "Dismissing…" : "Dismiss"}
                      </button>
                    </div>
                    {j.detail && (
                      <pre className="max-h-28 overflow-auto whitespace-pre-wrap rounded border border-red-200 bg-white/70 px-2 py-1 text-[11px] leading-snug text-red-900/90 dark:border-red-900/40 dark:bg-black/30 dark:text-red-200/90">
                        {j.detail}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Paused callout */}
          {paused.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-900/40 dark:bg-amber-900/20">
              <p className="mb-2 font-medium text-amber-800 dark:text-amber-300">
                {paused.length} build{paused.length === 1 ? "" : "s"} paused — awaiting owner action
              </p>
              <ul className="space-y-1.5">
                {paused.map((j) => (
                  <li key={j.id} className="flex flex-wrap items-center gap-2 text-amber-700 dark:text-amber-300">
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                      {j.status === "needs_approval" ? "needs approval" : "needs input"}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-amber-200/60 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-800/40 dark:text-amber-200">
                      {j.kind}
                    </span>
                    {/* A paused job is awaiting owner action → the routed Agents inbox (single source). */}
                    <Link
                      href={routedInboxHref()}
                      className="font-medium underline decoration-dotted underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
                    >
                      {j.spec_slug}
                    </Link>
                    {j.spec_missing && <span className="text-[10px] text-amber-700/70 dark:text-amber-300/70">(spec archived)</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
