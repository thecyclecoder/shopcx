/**
 * cs-director-digest — the composer behind the `cs_director_digests` table
 * ([[../tables/cs_director_digests]]).
 *
 * Phase 1 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]].
 * Replaces the per-ticket founder-escalation firehose with a BATCHED weekly digest: the CS Director
 * composes systemic early-warnings ("3 refunds this week, all melted-in-transit → packaging signal")
 * and precedent judgment calls into a periodic digest instead of paging on every escalation. Called
 * from the weekly cron ([[../inngest/cs-director-digest-composer]]).
 *
 * Storylines are composed from three sources — all read-only, all best-effort (a source that fails
 * to read still lets the composer emit the digest with the surviving storylines):
 *   (a) recent cs-director-call verdicts — `director_activity` rows where
 *       `director_function='cs'` + `action_kind='cs_director_call'` in the period window. Each
 *       verdict becomes a `precedent_call` storyline (its `decision` shapes the proposed_action:
 *       `escalate_founder` → widen_leash / add_policy; `author_spec` → add_rule; `approve_remedy` → null).
 *   (b) recurring problem patterns in `ticket_resolution_events` — problem strings that appeared on
 *       ≥ RECURRING_PROBLEM_THRESHOLD tickets during the window become one `early_warning` storyline
 *       each (the systemic signal the per-ticket page can't see).
 *   (c) precedent judgment calls tagged for CEO review — the subset of (a) with a `precedent:true`
 *       flag in metadata (a future Phase-2 tag; kept as a discrete source so the composer's contract
 *       already covers it).
 *
 * The composer is IDEMPOTENT per (workspace, digest_period_start): a second call for the same
 * workspace and period returns the existing row without inserting a duplicate — the weekly cron's
 * `retries:1` retry can't fan out two digests for the same week.
 */

import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** A problem string must appear on this many distinct tickets in the period to surface as an early-warning storyline. */
const RECURRING_PROBLEM_THRESHOLD = 3;

/** Trim `evidence` / `title` payloads so a single digest row never balloons — the founder reads storylines, not walls. */
const MAX_EVIDENCE_LEN = 800;

export type CsStorylineKind =
  | "early_warning" // a recurring problem pattern surfaced across tickets — systemic signal.
  | "precedent_call" // a cs-director-call verdict worth remembering as a precedent for the CEO.
  // Phase 2 — a per-ticket founder-escalation appended to the current digest INSTEAD of firing a
  // dashboard_notifications page. Only fires for `escalate_founder` verdicts classified as non-black-swan
  // ([[cs-director-black-swan]]). Black-swan verdicts still page in real time.
  | "per_ticket_escalation";

export type CsStorylineProposedActionType =
  | "widen_leash"
  | "tighten_leash"
  | "add_policy"
  | "add_rule"
  | null;

/** One storyline in a digest's `storylines` array. Free-form `evidence`; Phase 2 consumes `proposed_action`. */
export interface CsStoryline {
  kind: CsStorylineKind;
  title: string;
  evidence: string;
  proposed_action: {
    type: CsStorylineProposedActionType;
    // Free-form seed Phase 2's reply surface consumes when the founder clicks the action:
    //  - widen_leash / tighten_leash: no extra keys (the CS `function_autonomy` row is the target).
    //  - add_policy: { policy_draft } — the draft body prefilled from `evidence`.
    //  - add_rule: { rule_draft, kind:'rule' } — the sonnet_prompts row seed.
    // Phase 1 only records the shape; Phase 2 wires the mutation.
    payload?: Record<string, unknown>;
  };
}

/** The composer's inserted row shape. */
export interface CsDirectorDigestRow {
  id: string;
  workspace_id: string;
  digest_period_start: string;
  digest_period_end: string;
  storylines: CsStoryline[];
  created_at: string;
}

interface DirectorActivityRow {
  id: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  spec_slug: string | null;
  created_at: string;
}

interface ResolutionEventRow {
  ticket_id: string;
  problem: string | null;
  verified_outcome: string | null;
  staged_at: string;
}

/** Trim to a hard char cap without slicing mid-multibyte. Cheap + safe for ASCII/latin-1 evidence. */
function trim(text: string, max = MAX_EVIDENCE_LEN): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Map a cs-director-call decision → the founder-actionable proposed_action for the storyline. */
function proposedActionForDecision(decision: string, reasoning: string): CsStoryline["proposed_action"] {
  // `escalate_founder` → the CS Director hit her leash; the founder either widens it or codifies the
  // judgment as a policy. Default to `add_policy` since a widened leash without a written policy is
  // the exact Goodhart drift the spec's anti-goodhart clause warns against.
  if (decision === "escalate_founder") {
    return { type: "add_policy", payload: { policy_draft: trim(reasoning) } };
  }
  // `author_spec` → the CS Director surfaced an analyzer/rule gap. The founder acts by ADDING A RULE
  // (a sonnet_prompts row) so the same class of miss doesn't recur while the spec is being built.
  if (decision === "author_spec") {
    return { type: "add_rule", payload: { rule_draft: trim(reasoning), kind: "rule" } };
  }
  // `approve_remedy` → the CS Director acted in leash. Nothing for the founder to click; the storyline
  // is informational — the founder can still remember the precedent for later without a mutation.
  return { type: null };
}

/** Read the CS Director's verdicts from `director_activity` in the window. Best-effort; empty on failure. */
async function readCsDirectorVerdicts(
  admin: Admin,
  workspaceId: string,
  since: string,
  until: string,
): Promise<DirectorActivityRow[]> {
  try {
    const { data, error } = await admin
      .from("director_activity")
      .select("id, reason, metadata, spec_slug, created_at")
      .eq("workspace_id", workspaceId)
      .eq("director_function", "cs")
      .eq("action_kind", "cs_director_call")
      .gte("created_at", since)
      .lt("created_at", until)
      .order("created_at", { ascending: true });
    if (error) {
      console.warn("[cs-director-digest] director_activity read failed:", error.message);
      return [];
    }
    return (data ?? []) as DirectorActivityRow[];
  } catch (err) {
    console.warn("[cs-director-digest] director_activity read threw:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Read the count of Sol re-session cap-hits in the window + the workspace's alarm threshold.
 * Fix 1 (Phase 4) of [[../specs/sol-runaway-re-session-cap-guardrail]] — supplies the input
 * for `composeCapHitEscalation` below. Best-effort: on any read failure returns `{count:0,
 * threshold:null}` so a transient outage never blocks the digest.
 *
 * `threshold` is the MAX of all `ai_channel_config.sol_cap_hit_alarm` values across the
 * workspace's channels (a workspace with any channel opted out via a higher threshold still
 * gets the systemic warning at the loosest bound). If no config row exists, the default `5`
 * (matching the column default) is used.
 */
async function readCapHitCountAndAlarm(
  admin: Admin,
  workspaceId: string,
  since: string,
  until: string,
): Promise<{ count: number; threshold: number; kinds: { frustration: number; drift: number } }> {
  try {
    const { data: rows, error } = await admin
      .from("ticket_resolution_events")
      .select("ticket_id, chosen")
      .eq("workspace_id", workspaceId)
      .eq("reasoning", "sol:cap-hit")
      .gte("staged_at", since)
      .lt("staged_at", until);
    if (error) {
      console.warn("[cs-director-digest] cap-hit count read failed:", error.message);
      return { count: 0, threshold: 5, kinds: { frustration: 0, drift: 0 } };
    }
    const events = (rows ?? []) as Array<{
      ticket_id: string;
      chosen: Record<string, unknown> | null;
    }>;
    const kinds = { frustration: 0, drift: 0 };
    for (const ev of events) {
      const k = (ev.chosen ?? {})["kind"];
      if (k === "frustration") kinds.frustration += 1;
      else if (k === "drift") kinds.drift += 1;
    }

    let threshold = 5;
    try {
      const { data: cfgRows } = await admin
        .from("ai_channel_config")
        .select("sol_cap_hit_alarm")
        .eq("workspace_id", workspaceId);
      const cfgs = (cfgRows ?? []) as Array<{ sol_cap_hit_alarm: number | null }>;
      const values = cfgs
        .map((c) => c.sol_cap_hit_alarm)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (values.length > 0) threshold = Math.max(...values);
    } catch {
      // ai_channel_config unavailable — fall back to the schema default (5).
    }

    return { count: events.length, threshold, kinds };
  } catch (err) {
    console.warn(
      "[cs-director-digest] cap-hit count read threw:",
      err instanceof Error ? err.message : err,
    );
    return { count: 0, threshold: 5, kinds: { frustration: 0, drift: 0 } };
  }
}

/**
 * Compose ONE `early_warning` storyline when the workspace's rolling cap-hit count in the
 * digest window strictly EXCEEDS `sol_cap_hit_alarm`. Fix 1 (Phase 4) of
 * [[../specs/sol-runaway-re-session-cap-guardrail]] — the spec's own words: "When
 * cap_hits.total_7d exceeds a workspace-tunable threshold ... post an internal-note
 * escalation to the CS Director digest so June sees it in the next digest cycle".
 *
 * Below-threshold windows return `[]` — no storyline noise on healthy weeks. This is a
 * SYSTEMIC storyline (like recurring-problem `early_warning`s), not a per-ticket
 * escalation, so it lives on the digest's `storylines` array alongside the other
 * composer sources rather than paging in real time.
 */
function composeCapHitEscalation(input: {
  count: number;
  threshold: number;
  kinds: { frustration: number; drift: number };
}): CsStoryline[] {
  if (input.count <= input.threshold) return [];
  const evidenceBits: string[] = [
    `${input.count} cap-hits in the window`,
    `threshold ${input.threshold}`,
  ];
  if (input.kinds.frustration || input.kinds.drift) {
    evidenceBits.push(`frustration ${input.kinds.frustration} · drift ${input.kinds.drift}`);
  }
  return [
    {
      kind: "early_warning",
      title: trim("Sol re-session cap hit (systemic)", 160),
      evidence: trim(evidenceBits.join(" · "), MAX_EVIDENCE_LEN),
      // A recurring cap-hit is a bounded-proxy signal (frustration is bouncing to Sol at a
      // rate the cap is now catching) — the founder acts by widening the leash OR by
      // codifying a new rule that catches the pattern earlier. Default `add_policy`
      // matches the other systemic `early_warning` storylines.
      proposed_action: {
        type: "add_policy",
        payload: {
          policy_draft: `Sol re-session cap hit ${input.count}x — frustration ${input.kinds.frustration}, drift ${input.kinds.drift}. Investigate the pathological tickets and either widen sol_max_resessions or add a rule that catches the pattern earlier.`,
        },
      },
    },
  ];
}

/** Read the ticket_resolution_events rows in the window. Best-effort; empty on failure. */
async function readResolutionEvents(
  admin: Admin,
  workspaceId: string,
  since: string,
  until: string,
): Promise<ResolutionEventRow[]> {
  try {
    const { data, error } = await admin
      .from("ticket_resolution_events")
      .select("ticket_id, problem, verified_outcome, staged_at")
      .eq("workspace_id", workspaceId)
      .gte("staged_at", since)
      .lt("staged_at", until)
      .not("problem", "is", null)
      .limit(5000);
    if (error) {
      console.warn("[cs-director-digest] ticket_resolution_events read failed:", error.message);
      return [];
    }
    return (data ?? []) as ResolutionEventRow[];
  } catch (err) {
    console.warn("[cs-director-digest] ticket_resolution_events read threw:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Group the resolution-events rows by normalized `problem` text, count DISTINCT tickets per group, and
 * emit an `early_warning` storyline per group whose distinct-ticket count meets RECURRING_PROBLEM_THRESHOLD.
 * A problem repeated on the SAME ticket across many turns is NOT a systemic signal — the ticket-count
 * (not the row-count) is what earns a storyline.
 */
function composeEarlyWarnings(rows: ResolutionEventRow[]): CsStoryline[] {
  const perProblem = new Map<string, { display: string; tickets: Set<string>; drifted: number; unbacked: number }>();
  for (const r of rows) {
    const raw = (r.problem ?? "").trim();
    if (!raw) continue;
    // Normalize whitespace for the group key so "melted in transit" and "melted  in transit" collapse.
    const key = raw.replace(/\s+/g, " ").toLowerCase();
    const bucket = perProblem.get(key) ?? { display: raw, tickets: new Set<string>(), drifted: 0, unbacked: 0 };
    bucket.tickets.add(r.ticket_id);
    if (r.verified_outcome === "drifted") bucket.drifted++;
    else if (r.verified_outcome === "unbacked") bucket.unbacked++;
    perProblem.set(key, bucket);
  }

  const storylines: CsStoryline[] = [];
  for (const [, bucket] of perProblem) {
    if (bucket.tickets.size < RECURRING_PROBLEM_THRESHOLD) continue;
    const evidenceBits: string[] = [`${bucket.tickets.size} distinct tickets`];
    if (bucket.drifted) evidenceBits.push(`${bucket.drifted} drifted verifications`);
    if (bucket.unbacked) evidenceBits.push(`${bucket.unbacked} unbacked responses`);
    storylines.push({
      kind: "early_warning",
      title: trim(bucket.display, 160),
      evidence: trim(evidenceBits.join(" · "), MAX_EVIDENCE_LEN),
      // Recurring problem patterns default to `add_policy` — the systemic fix is written policy, not
      // a leash tweak on the CS Director's per-call ceiling.
      proposed_action: {
        type: "add_policy",
        payload: { policy_draft: `Recurring problem: ${trim(bucket.display, 300)}` },
      },
    });
  }
  // Sort by distinct-ticket count desc so the loudest signal reads first in the CEO surface.
  storylines.sort((a, b) => {
    const ac = Number(String(a.evidence).match(/^(\d+)/)?.[1] ?? 0);
    const bc = Number(String(b.evidence).match(/^(\d+)/)?.[1] ?? 0);
    return bc - ac;
  });
  return storylines;
}

/** Compose one `precedent_call` storyline per cs-director-call verdict in the window. */
function composePrecedentCalls(rows: DirectorActivityRow[]): CsStoryline[] {
  const out: CsStoryline[] = [];
  for (const r of rows) {
    const meta = r.metadata ?? {};
    const decision = typeof meta["decision"] === "string" ? (meta["decision"] as string) : "escalate_founder";
    const reasoning = (r.reason ?? "").trim();
    // Title = the human-readable precedent header. Prefer the SpecSeed title when the decision was
    // `author_spec` and one is present; otherwise the decision itself is the title.
    const seed = meta["spec_seed"] && typeof meta["spec_seed"] === "object" ? (meta["spec_seed"] as Record<string, unknown>) : null;
    const seedTitle = seed && typeof seed["title"] === "string" ? (seed["title"] as string) : "";
    const title = trim(seedTitle || `${decision.replace(/_/g, " ")}`, 160);
    out.push({
      kind: "precedent_call",
      title,
      evidence: trim(reasoning || "(no reasoning captured)", MAX_EVIDENCE_LEN),
      proposed_action: proposedActionForDecision(decision, reasoning),
    });
  }
  return out;
}

/** Read the `sol_messy_turns` coaching signals (from both Cora tiers) in the window. Best-effort. */
async function readMessyTurnSignals(
  admin: Admin,
  workspaceId: string,
  since: string,
  until: string,
): Promise<DirectorActivityRow[]> {
  try {
    const { data, error } = await admin
      .from("director_activity")
      .select("id, reason, metadata, spec_slug, created_at")
      .eq("workspace_id", workspaceId)
      .eq("director_function", "cs")
      .eq("action_kind", "sol_messy_turns")
      .gte("created_at", since)
      .lt("created_at", until)
      .order("created_at", { ascending: true });
    if (error) {
      console.warn("[cs-director-digest] sol_messy_turns read failed:", error.message);
      return [];
    }
    return (data ?? []) as DirectorActivityRow[];
  } catch (err) {
    console.warn("[cs-director-digest] sol_messy_turns read threw:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Roll up the per-ticket `sol_messy_turns` coaching signals — emitted by BOTH the cheap triage pass
 * and Cora's deep session ([[sol-coaching-signal]]) — into `early_warning` storylines. Each row's
 * `metadata.signals` lists the recovered-stumble classes seen on that ticket; we group by CLASS and
 * count DISTINCT tickets (a class messy on the same ticket across many turns is not a systemic
 * signal — the ticket-count earns the storyline, mirroring composeEarlyWarnings). A class that
 * repeats across ≥ RECURRING_PROBLEM_THRESHOLD tickets surfaces with an `add_rule` proposed_action:
 * the systemic fix for a recurring Sol mid-turn pattern is a codified rule (a sonnet_prompts row)
 * that catches it earlier, not a leash tweak. Pure + unit-testable.
 */
export function composeMessyTurnWarnings(rows: DirectorActivityRow[]): CsStoryline[] {
  const perClass = new Map<string, { tickets: Set<string>; cheap: number; cora: number }>();
  for (const r of rows) {
    const meta = r.metadata ?? {};
    const ticketId = typeof meta["ticket_id"] === "string" ? (meta["ticket_id"] as string) : r.id;
    const tier = meta["tier"] === "cheap" || meta["tier"] === "cora" ? (meta["tier"] as string) : null;
    const signals = Array.isArray(meta["signals"]) ? (meta["signals"] as unknown[]).filter((s): s is string => typeof s === "string") : [];
    for (const cls of signals) {
      const bucket = perClass.get(cls) ?? { tickets: new Set<string>(), cheap: 0, cora: 0 };
      bucket.tickets.add(ticketId);
      if (tier === "cheap") bucket.cheap++;
      else if (tier === "cora") bucket.cora++;
      perClass.set(cls, bucket);
    }
  }

  const storylines: CsStoryline[] = [];
  for (const [cls, bucket] of perClass) {
    if (bucket.tickets.size < RECURRING_PROBLEM_THRESHOLD) continue;
    const evidenceBits = [`${bucket.tickets.size} distinct tickets`, `via cheap ${bucket.cheap} · cora ${bucket.cora}`];
    storylines.push({
      kind: "early_warning",
      title: trim(`Recurring Sol stumble: ${cls.replace(/_/g, " ")}`, 160),
      evidence: trim(evidenceBits.join(" · "), MAX_EVIDENCE_LEN),
      proposed_action: {
        type: "add_rule",
        payload: {
          kind: "rule",
          rule_draft: `Sol repeatedly showed the "${cls}" mid-turn pattern (recovered by close) across ${bucket.tickets.size} tickets. Add a rule / instruction that catches this earlier so it stops recurring.`,
        },
      },
    });
  }
  storylines.sort((a, b) => {
    const ac = Number(String(a.evidence).match(/^(\d+)/)?.[1] ?? 0);
    const bc = Number(String(b.evidence).match(/^(\d+)/)?.[1] ?? 0);
    return bc - ac;
  });
  return storylines;
}

/**
 * Look for an existing digest row for (workspace, period_start). The composer inserts idempotently
 * against this key so a cron retry never fans out two digests for the same week.
 */
async function existingDigestFor(
  admin: Admin,
  workspaceId: string,
  periodStart: string,
): Promise<CsDirectorDigestRow | null> {
  try {
    const { data, error } = await admin
      .from("cs_director_digests")
      .select("id, workspace_id, digest_period_start, digest_period_end, storylines, created_at")
      .eq("workspace_id", workspaceId)
      .eq("digest_period_start", periodStart)
      .limit(1);
    if (error) {
      console.warn("[cs-director-digest] existing lookup failed:", error.message);
      return null;
    }
    const row = (data ?? [])[0];
    if (!row) return null;
    return {
      ...(row as CsDirectorDigestRow),
      storylines: Array.isArray(row.storylines) ? (row.storylines as CsStoryline[]) : [],
    };
  } catch (err) {
    console.warn("[cs-director-digest] existing lookup threw:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Compose (and insert, if not already present) ONE weekly digest row for the workspace's period.
 * `since` (inclusive) and `until` (exclusive) are ISO timestamps.
 *
 * Returns `{ inserted, row, storylineCount }`:
 *   - `inserted:true` when this call actually persisted a new row.
 *   - `inserted:false` when a row for (workspace, periodStart) already existed (returned as-is).
 *
 * Never throws — every read is best-effort, and a failed INSERT logs + returns `{ inserted:false, row:null }`.
 */
export async function composeCsDirectorDigest(
  admin: Admin,
  workspaceId: string,
  since: string,
  until: string,
): Promise<{ inserted: boolean; row: CsDirectorDigestRow | null; storylineCount: number }> {
  if (!workspaceId) return { inserted: false, row: null, storylineCount: 0 };
  if (!since || !until || new Date(until) <= new Date(since)) {
    return { inserted: false, row: null, storylineCount: 0 };
  }

  const existing = await existingDigestFor(admin, workspaceId, since);
  if (existing) {
    return {
      inserted: false,
      row: existing,
      storylineCount: Array.isArray(existing.storylines) ? existing.storylines.length : 0,
    };
  }

  const [verdicts, events, capHits, messyTurns] = await Promise.all([
    readCsDirectorVerdicts(admin, workspaceId, since, until),
    readResolutionEvents(admin, workspaceId, since, until),
    readCapHitCountAndAlarm(admin, workspaceId, since, until),
    readMessyTurnSignals(admin, workspaceId, since, until),
  ]);

  const storylines = [
    ...composeEarlyWarnings(events),
    ...composePrecedentCalls(verdicts),
    ...composeCapHitEscalation(capHits),
    ...composeMessyTurnWarnings(messyTurns),
  ];

  try {
    const { data, error } = await admin
      .from("cs_director_digests")
      .insert({
        workspace_id: workspaceId,
        digest_period_start: since,
        digest_period_end: until,
        storylines,
      })
      .select("id, workspace_id, digest_period_start, digest_period_end, storylines, created_at")
      .single();
    if (error) {
      console.warn("[cs-director-digest] insert failed:", error.message);
      return { inserted: false, row: null, storylineCount: storylines.length };
    }
    const row = data as CsDirectorDigestRow;
    return { inserted: true, row, storylineCount: storylines.length };
  } catch (err) {
    console.warn("[cs-director-digest] insert threw:", err instanceof Error ? err.message : err);
    return { inserted: false, row: null, storylineCount: storylines.length };
  }
}

/**
 * Phase 2 — one week of a rolling digest window. Used by [[appendPerTicketEscalation]] to compute
 * the CURRENT digest window when it needs to (a) find the open digest to append to, or (b) create a
 * new one lazily when no digest row exists for this workspace's current week.
 */
const CURRENT_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Phase 2 — append ONE `per_ticket_escalation` storyline to the CURRENT digest row for the
 * workspace, INSTEAD of firing a `dashboard_notifications` real-time page. Called from
 * `runCsDirectorCallJob` when [[cs-director-black-swan]] `classifyBlackSwan` returns `isBlackSwan:false`
 * on an `escalate_founder` verdict — the non-black-swan tail that would otherwise flood the founder.
 *
 * "Current" = the LATEST `cs_director_digests` row for the workspace. If none exists (the composer
 * cron hasn't fired yet this week, or this is the workspace's very first CS escalation), the helper
 * LAZILY creates a digest row for the current week's window with `storylines=[]` and appends into
 * that. This keeps the invariant: EVERY per-ticket escalation lands on a durable digest row the
 * founder can act on — never a silent drop.
 *
 * The append is not a compare-and-set on `storylines` (Postgres jsonb concat is a single
 * atomic UPDATE): we read-modify-write on the row's `storylines` array with an `id`-scoped WHERE.
 * A concurrent second call in the same tick could clobber — that risk is tiny for a per-ticket
 * escalation (the CS Director's Max session serializes calls), and the eventual weekly digest
 * still surfaces the missed row through the composer's own read.
 *
 * Best-effort + never throws — a failed append still returns `{ appended:false }` so the caller
 * can decide to fall through to `dashboard_notifications`.
 */
export async function appendPerTicketEscalation(
  admin: Admin,
  input: {
    workspaceId: string;
    ticketId: string;
    reasoning: string;
    verdictMetadata: Record<string, unknown> | null;
  },
): Promise<{ appended: boolean; digest_id: string | null; storyline_index: number }> {
  if (!input.workspaceId || !input.ticketId) return { appended: false, digest_id: null, storyline_index: -1 };

  try {
    // 1) Find the LATEST digest row for the workspace — that is the "current" one to append to.
    const { data: existing, error: readErr } = await admin
      .from("cs_director_digests")
      .select("id, storylines")
      .eq("workspace_id", input.workspaceId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (readErr) {
      console.warn("[cs-director-digest] appendPerTicketEscalation read failed:", readErr.message);
      return { appended: false, digest_id: null, storyline_index: -1 };
    }
    let digestId: string | null = null;
    let currentStorylines: CsStoryline[] = [];
    if (Array.isArray(existing) && existing.length > 0) {
      digestId = String(existing[0].id);
      currentStorylines = Array.isArray(existing[0].storylines) ? (existing[0].storylines as CsStoryline[]) : [];
    } else {
      // 2) No digest exists yet — LAZILY create one for the current week so the escalation has a home.
      const nowIso = new Date().toISOString();
      const since = new Date(new Date(nowIso).getTime() - CURRENT_WEEK_MS).toISOString();
      const { data: created, error: createErr } = await admin
        .from("cs_director_digests")
        .insert({
          workspace_id: input.workspaceId,
          digest_period_start: since,
          digest_period_end: nowIso,
          storylines: [],
        })
        .select("id")
        .single();
      if (createErr || !created) {
        console.warn("[cs-director-digest] lazy-create digest for append failed:", createErr?.message ?? "no row");
        return { appended: false, digest_id: null, storyline_index: -1 };
      }
      digestId = String(created.id);
      currentStorylines = [];
    }

    const storyline: CsStoryline = {
      kind: "per_ticket_escalation",
      title: `Ticket ${input.ticketId.slice(0, 8)} — CS Director escalated`,
      evidence: trim(input.reasoning || "(no reasoning captured)"),
      proposed_action: {
        // A per-ticket escalation typically wants a policy write-up so the SAME class of judgment
        // doesn't need to escalate again next time. The founder can still click Widen/Tighten Leash.
        type: "add_policy",
        payload: {
          policy_draft: trim(input.reasoning || ""),
          ticket_id: input.ticketId,
          verdict_metadata: input.verdictMetadata ?? null,
        },
      },
    };

    // 3) Append to the digest's storylines array — id-scoped + workspace-scoped WHERE so a
    //    misfire on a different workspace's row is impossible (guard-before-mutation: the write
    //    only fires when both id AND workspace_id match, and we `.select("id")` to confirm exactly
    //    one row transitioned).
    const nextStorylines = [...currentStorylines, storyline];
    const { data: updated, error: updateErr } = await admin
      .from("cs_director_digests")
      .update({ storylines: nextStorylines })
      .eq("id", digestId)
      .eq("workspace_id", input.workspaceId)
      .select("id");
    if (updateErr) {
      console.warn("[cs-director-digest] appendPerTicketEscalation update failed:", updateErr.message);
      return { appended: false, digest_id: digestId, storyline_index: -1 };
    }
    if (!Array.isArray(updated) || updated.length !== 1) {
      console.warn(
        `[cs-director-digest] appendPerTicketEscalation transitioned ${Array.isArray(updated) ? updated.length : 0} rows (expected 1)`,
      );
      return { appended: false, digest_id: digestId, storyline_index: -1 };
    }
    return { appended: true, digest_id: digestId, storyline_index: nextStorylines.length - 1 };
  } catch (err) {
    console.warn("[cs-director-digest] appendPerTicketEscalation threw:", err instanceof Error ? err.message : err);
    return { appended: false, digest_id: null, storyline_index: -1 };
  }
}
