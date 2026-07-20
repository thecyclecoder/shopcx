/**
 * pulse — the founder-pulse synthesizer.
 *
 * Joins the [[../tables/pulse_session_digests]] rows (Phase 1) against the
 * specs / agent_jobs ledger (via [[specs-table]] `listSpecs`) and produces
 * the five lenses that render on `/dashboard/developer/pulse`:
 *
 *   what's_working · where_you_left_off · rabbit_holes · next_moves · threads_in_flight
 *
 * Two-stage synthesis:
 *  1. DETERMINISTIC join — pure code, unit-testable without any LLM call.
 *     Every claim it emits carries at least one cite (session digest id,
 *     spec slug, commit sha, or job id) so the surface never carries a
 *     free-floating assertion.
 *  2. OPTIONAL LLM narrative pass — Haiku rewrites each lens's claims in
 *     the founder's voice from the SAME structured evidence + cite ids.
 *     If the API is unavailable the deterministic prose ships as-is.
 *
 * Read the digest for the wider design in docs/brain/specs/founder-pulse.md.
 * Phase 2 of that spec.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getAllSpecs, type SpecRow, type SpecStatus } from "@/lib/specs-table";
import { HAIKU_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import { SESSION_AUTHORED_MODEL, type DigestThread, type DigestRef, type DigestDecision } from "@/lib/pulse-digest";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/** The five lens keys. Order matters — the /pulse page renders in this order. */
export const LENS_KEYS = [
  "whats_working",
  "where_you_left_off",
  "rabbit_holes",
  "next_moves",
  "threads_in_flight",
] as const;

export type LensKey = (typeof LENS_KEYS)[number];

/** One claim inside a lens — always cite-anchored (≥1 cite_ids). */
export interface LensClaim {
  claim: string;
  cite_ids: string[];
}

/** A cite the lenses point at — the pulse page renders each as a small superscript link. */
export interface Cite {
  kind: "session" | "spec" | "commit" | "pr" | "brain" | "file" | "url";
  ref: string;
  label: string;
}

/** The five lenses of the founder-pulse surface. */
export type PulseLenses = Record<LensKey, LensClaim[]>;

export interface PulseSnapshot {
  subject: string;
  lenses: PulseLenses;
  cites: Record<string, Cite>;
  synthesized_at: string;
  model: string;
}

/** One row from pulse_session_digests as the synthesizer sees it. */
export interface DigestInput {
  id: string;
  session_id: string;
  intent: string | null;
  resume_point: string | null;
  last_activity_at: string | null;
  decisions: DigestDecision[];
  threads: DigestThread[];
  refs: DigestRef[];
  /**
   * The digest_model marker from `pulse_session_digests.digest_model`.
   * When it equals `SESSION_AUTHORED_MODEL`, the assistant wrote this digest
   * from ground truth inside a live session ([[../.claude/skills/recap]]) —
   * `thread.status` is authoritative and exact refs should override the
   * slug-substring fallback in `matchThreadsToSpecs`. See
   * [[../specs/pulse-session-authored-recaps]] Phase 3.
   */
  digest_model: string | null;
}

interface JobInput {
  id: string;
  spec_slug: string;
  status: string;
  pr_number: number | null;
  pr_url: string | null;
  updated_at: string | null;
}

export interface BuildPulseFixtures {
  digests: DigestInput[];
  specs: SpecRow[];
  jobs?: JobInput[];
}

const SCRIPT_NOISE_PREFIXES = ["_", "scripts/_"];

/**
 * Does this thread title / ref value look like a disposable one-off script
 * (`scripts/_probe-foo.ts`, `_backfill-bar.ts`, …)? The same class of noise
 * the drift detector already ignores (commit d61e7a18) — don't surface as work.
 */
export function isScriptNoise(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  for (const prefix of SCRIPT_NOISE_PREFIXES) {
    if (t.startsWith(prefix)) return true;
  }
  // Any `scripts/_foo.ts` reference by path
  if (/\bscripts\/_[a-z0-9-]+\.ts\b/.test(t)) return true;
  return false;
}

/** A spec is in a "settled" state (fold/ship/reject) or actively building. Threads pointing here are RESOLVED. */
export function isSpecSettledOrInFlight(spec: SpecRow): boolean {
  const status = deriveSpecStatus(spec);
  if (status === "folded" || status === "shipped" || status === "in_progress") return true;
  // A build_sha on any phase means work landed on the branch, even if the spec column still says planned.
  return spec.phases.some((p) => p.build_sha !== null || p.merge_sha !== null || p.pr !== null);
}

/**
 * Derive a spec's rolled-up lifecycle status the same way brain-roadmap does at read time.
 * Explicit lifecycle overrides (in_review / deferred / folded) win; otherwise we roll up the phases.
 */
export function deriveSpecStatus(spec: SpecRow): SpecStatus | "in_progress" | "shipped" | "planned" {
  if (spec.status === "folded" || spec.status === "deferred" || spec.status === "in_review") return spec.status;
  if (spec.phases.length === 0) {
    if (spec.merged_pr !== null || spec.last_merge_sha !== null) return "shipped";
    return "planned";
  }
  const allShipped = spec.phases.every((p) => p.status === "shipped");
  if (allShipped) return "shipped";
  const anyInFlight = spec.phases.some((p) => p.status === "in_progress" || p.status === "shipped");
  return anyInFlight ? "in_progress" : "planned";
}

/**
 * Normalize a text fragment into a slug-ish key for matching a thread against a spec slug.
 * We are permissive on purpose — a session might say "founder-pulse" or "founder pulse"
 * or "founder pulse spec"; all three should match `founder-pulse`.
 */
export function normalizeForMatch(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[\[\]]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * How a thread resolved to its ledger anchor:
 *  - `ref:spec` — the digest's refs[] carried a `kind='spec'` value that matched a workspace spec slug EXACTLY.
 *  - `ref:pr` — the digest's refs[] carried a `kind='pr'` value that matched an active spec's `merged_pr` or a phase's `pr`, OR an agent_jobs row's `pr_number`.
 *  - `ref:commit` — the digest's refs[] carried a `kind='commit'` value (a sha — treated as "shipped" per [[../specs/pulse-session-authored-recaps]] Phase 3).
 *  - `slug-substring` — the legacy fallback: the workspace slug appears somewhere in the thread's title/cite or a digest ref value.
 *  - `none` — no ledger anchor at all.
 * Session-authored digests prefer the ref-based paths so exact citations override lossy substring guessing.
 */
export type ThreadMatchVia = "ref:spec" | "ref:pr" | "ref:commit" | "slug-substring" | "none";

interface ThreadMatch {
  thread: DigestThread;
  digest: DigestInput;
  matchedSpec: SpecRow | null;
  /** Set when a `kind='pr'` ref resolved to an active build job. In-flight signal even if no spec matched. */
  matchedJob: JobInput | null;
  /** Raw `kind='commit'` sha from refs — a work-landed signal for the no-spec-work-stuck-open case. */
  matchedCommit: string | null;
  /** Raw `kind='pr'` number from refs — used to look up the PR against specs' merged_pr / phase.pr. */
  matchedPr: number | null;
  /** How the anchor was found. */
  matchedVia: ThreadMatchVia;
  /**
   * The digest thread's explicit status, ONLY when the digest is session-authored
   * ([[../specs/pulse-session-authored-recaps]] Phase 3). Null for Haiku-ingest threads
   * whose status was derived from tone. `synthesizeDeterministic` treats a non-null
   * `authorStatus` as authoritative — a `resolved` here bypasses the ledger re-derive.
   */
  authorStatus: DigestThread["status"] | null;
}

/**
 * Look up a PR ref value (the number as a string) against the workspace specs — a
 * spec whose `merged_pr` equals the number, or one whose `phase.pr` does. Returns
 * the matching spec (settled OR in-flight — the caller decides via
 * `isSpecSettledOrInFlight`) so the confirming predicate for "this PR belongs to
 * this workspace's ledger" is proved at match time, not by a bare number.
 */
function findSpecByPrNumber(specs: SpecRow[], prNumber: number): SpecRow | null {
  for (const s of specs) {
    if (s.merged_pr === prNumber) return s;
    for (const p of s.phases) {
      if (p.pr === prNumber) return s;
    }
  }
  return null;
}

/**
 * Is a `pr` ref value already MERGED anywhere in the ledger? A number counts as
 * merged when a spec's `merged_pr` (one-shot spec) equals it AND `last_merge_sha`
 * is set, OR when any phase carries `phase.pr === n && phase.merge_sha !== null`.
 * Used to answer "this thread has a merged PR ref, no spec anchor found — is it
 * still done?" (Phase 3 verification: PR '1160' should render under what's-working
 * even without a slug-substring anchor).
 */
function isPrNumberMerged(specs: SpecRow[], prNumber: number): boolean {
  for (const s of specs) {
    if (s.merged_pr === prNumber && s.last_merge_sha !== null) return true;
    for (const p of s.phases) {
      if (p.pr === prNumber && p.merge_sha !== null) return true;
    }
  }
  return false;
}

/**
 * Look up a PR ref value against the OPEN agent_jobs list (buildPulse's `jobs`
 * arg is already narrowed to non-terminal statuses — see the `in(...)` filter).
 * Returns the active job if there is one, so an in-flight PR still surfaces as
 * such even when the spec ledger hasn't caught up.
 */
function findJobByPrNumber(jobs: JobInput[], prNumber: number): JobInput | null {
  for (const j of jobs) {
    if (j.pr_number === prNumber) return j;
  }
  return null;
}

/**
 * For every thread across every digest, resolve it to its ledger anchor.
 *
 * Match order ([[../specs/pulse-session-authored-recaps]] Phase 3):
 *  1. **Exact refs first.** The digest's `refs[]` are consulted before anything
 *     else — `kind='spec'` joins the workspace specs by exact slug (via `listSpecs`),
 *     `kind='pr'` joins agent_jobs/specs by pr_number (in that order — the workspace
 *     spec ledger is the authority; the job list is a fallback in-flight signal),
 *     `kind='commit'` records the sha (treated as work-landed downstream).
 *  2. **Slug-substring fallback.** When no exact ref matched, the legacy path
 *     kicks in — normalize the thread's title/cite + digest.refs into a haystack
 *     and pick the longest workspace slug that appears in it.
 *
 * Threads pointing at script-noise are dropped BEFORE either match attempt (same
 * class the drift detector already ignores). A session-authored digest additionally
 * has its thread `status` carried on the match as `authorStatus` (Phase 3 authority
 * rule) so the caller can treat it as ground truth without re-deriving.
 */
export function matchThreadsToSpecs(digests: DigestInput[], specs: SpecRow[], jobs: JobInput[] = []): ThreadMatch[] {
  const out: ThreadMatch[] = [];
  const bySlug = new Map<string, SpecRow>();
  const slugs = specs.map((s) => s.slug);
  for (const s of specs) bySlug.set(s.slug, s);
  slugs.sort((a, b) => b.length - a.length); // longest first so `founder-pulse-v2` wins over `founder-pulse`
  for (const digest of digests) {
    const isAuthored = digest.digest_model === SESSION_AUTHORED_MODEL;
    for (const thread of digest.threads || []) {
      if (isScriptNoise(thread.title) || isScriptNoise(thread.cite)) continue;

      let matchedSpec: SpecRow | null = null;
      let matchedJob: JobInput | null = null;
      let matchedCommit: string | null = null;
      let matchedPr: number | null = null;
      let matchedVia: ThreadMatchVia = "none";

      // 1. Exact refs first — a session-authored ref (or any digest's ref that
      //    happens to be exact) beats any slug-substring guess. Refs are digest-scope
      //    so all threads in a digest share the pool; the fallback path did the same.
      for (const r of digest.refs || []) {
        if (!r || typeof r.value !== "string") continue;
        const value = r.value.trim();
        if (!value) continue;
        if (r.kind === "spec" && !matchedSpec) {
          const s = bySlug.get(value);
          if (s) {
            matchedSpec = s;
            matchedVia = "ref:spec";
          }
        } else if (r.kind === "pr" && matchedPr === null) {
          const asNumber = Number(value);
          if (Number.isFinite(asNumber) && asNumber > 0) {
            matchedPr = asNumber;
            // The workspace spec ledger is the authority for "this PR belongs to a spec".
            // Fall back to the open-jobs list for an in-flight PR that hasn't stamped a phase yet.
            const specForPr = findSpecByPrNumber(specs, asNumber);
            if (specForPr && !matchedSpec) matchedSpec = specForPr;
            const jobForPr = findJobByPrNumber(jobs, asNumber);
            if (jobForPr) matchedJob = jobForPr;
            if (matchedVia === "none") matchedVia = "ref:pr";
          }
        } else if (r.kind === "commit" && !matchedCommit) {
          matchedCommit = value;
          if (matchedVia === "none") matchedVia = "ref:commit";
        }
      }

      // 2. Slug-substring fallback — only when NO exact ref matched anything. Preserves
      //    the pre-Phase-3 behavior for Haiku-ingest threads (and session-authored threads
      //    that forgot to include exact refs) so the surface degrades gracefully.
      if (matchedVia === "none") {
        const haystack = [thread.title, thread.cite, ...(digest.refs || []).map((r) => r.value)]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .map((v) => normalizeForMatch(v))
          .join(" ");
        for (const slug of slugs) {
          if (haystack.includes(slug)) {
            matchedSpec = bySlug.get(slug) || null;
            if (matchedSpec) matchedVia = "slug-substring";
            break;
          }
        }
      }

      out.push({
        thread,
        digest,
        matchedSpec,
        matchedJob,
        matchedCommit,
        matchedPr,
        matchedVia,
        authorStatus: isAuthored ? (thread.status ?? null) : null,
      });
    }
  }
  return out;
}

/** Build the cite id for a session-digest reference. */
function citeIdForSession(d: DigestInput): string {
  return `session:${d.session_id}`;
}

/** Build the cite id for a spec reference. */
function citeIdForSpec(s: SpecRow): string {
  return `spec:${s.slug}`;
}

/** Build the cite id for an agent-job reference. */
function citeIdForJob(j: JobInput): string {
  return `job:${j.id}`;
}

function short(s: string, n = 160): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t;
}

/**
 * DETERMINISTIC synthesis — pure code, no LLM. Given digests + specs (+ optionally
 * agent_jobs), map the evidence into the five lenses and record every cite in
 * `snapshot.cites` keyed by a stable id. Every claim carries ≥1 cite_ids.
 *
 * This is the function the Phase-2 verification harness imports and asserts on.
 */
export function synthesizeDeterministic(fixtures: BuildPulseFixtures, opts?: { subject?: string; nowIso?: string }): PulseSnapshot {
  const { digests, specs, jobs = [] } = fixtures;
  const subject = opts?.subject || "founder";
  const cites: Record<string, Cite> = {};
  const lenses: PulseLenses = {
    whats_working: [],
    where_you_left_off: [],
    rabbit_holes: [],
    next_moves: [],
    threads_in_flight: [],
  };

  // Recent digests, newest first.
  const digestsByRecency = [...digests].sort((a, b) => {
    const ta = a.last_activity_at ? Date.parse(a.last_activity_at) : 0;
    const tb = b.last_activity_at ? Date.parse(b.last_activity_at) : 0;
    return tb - ta;
  });

  // Record every session digest as a cite the moment we encounter it (any lens may point at it).
  for (const d of digestsByRecency) {
    const id = citeIdForSession(d);
    cites[id] = {
      kind: "session",
      ref: d.session_id,
      label: d.intent ? short(d.intent, 80) : d.session_id.slice(0, 12),
    };
  }
  for (const s of specs) {
    cites[citeIdForSpec(s)] = { kind: "spec", ref: s.slug, label: s.title };
  }
  for (const j of jobs) {
    cites[citeIdForJob(j)] = {
      kind: "pr",
      ref: j.pr_number ? String(j.pr_number) : j.id,
      label: j.pr_url || `${j.spec_slug} · ${j.status}`,
    };
  }

  const matches = matchThreadsToSpecs(digestsByRecency, specs, jobs);
  const resolvedSlugsSeen = new Set<string>();
  const openSlugsSeen = new Set<string>();
  const resolvedNoSpecKeysSeen = new Set<string>();

  for (const m of matches) {
    const digest = m.digest;
    const digestCite = citeIdForSession(digest);

    // Author-noise wins immediately — a session-authored thread the founder marked as noise
    // goes to rabbit_holes below, not where_you_left_off, even if it happens to match a spec.
    // (For non-authored digests we still respect the ingest's `noise` classification.)
    if (m.thread.status === "noise") continue;

    // [[../specs/pulse-session-authored-recaps]] Phase 3 resolution rules — a thread is DONE when:
    //  (a) it's session-authored + author declared it resolved (authoritative), OR
    //  (b) the exact-matched spec is settled/in-flight (post-session shipping flips it), OR
    //  (c) an exact PR ref is merged in the ledger, OR
    //  (d) an exact commit ref exists (a sha means work landed).
    // Rule (a) trusts the assistant's ground truth even when the ledger hasn't caught up yet;
    // rules (b–d) trust the ledger even when the digest was authored before the work landed —
    // so "a session-authored thread with a ref kind='pr' value='1160' (merged) renders under
    // what's-working/done" (verification checklist).
    const authoredResolved = m.authorStatus === "resolved";
    const specSettled = m.matchedSpec && isSpecSettledOrInFlight(m.matchedSpec);
    const prMerged = m.matchedPr !== null && isPrNumberMerged(specs, m.matchedPr);
    const hasCommitRef = m.matchedCommit !== null;
    const isDone = authoredResolved || specSettled || prMerged || hasCommitRef;

    if (isDone) {
      if (m.matchedSpec) {
        // Ledger anchor available — reuse the spec-title claim shape so what's_working reads
        // as "the shipped spec, not a repeat of the raw thread title". Dedup by spec slug.
        if (resolvedSlugsSeen.has(m.matchedSpec.slug)) continue;
        resolvedSlugsSeen.add(m.matchedSpec.slug);
        const specCite = citeIdForSpec(m.matchedSpec);
        const specStatus = deriveSpecStatus(m.matchedSpec);
        // If the ledger hasn't caught up yet but the assistant already witnessed resolution,
        // present the spec neutrally as "landed" so the claim doesn't contradict the ledger.
        const stateLabel = specStatus === "folded" || specStatus === "shipped"
          ? specStatus
          : authoredResolved && !specSettled
            ? "landed (per session)"
            : "in flight";
        lenses.whats_working.push({
          claim: `${m.matchedSpec.title} is ${stateLabel} (started as “${short(m.thread.title, 60)}”).`,
          cite_ids: [specCite, digestCite],
        });
        continue;
      }
      // No spec anchor — but a merged PR / commit sha / author-declared resolution still counts.
      // (fixes no-spec-work-stuck-open per Phase 3.) Dedup so a PR referenced by many threads
      // doesn't fan out to N identical claims in what's_working.
      const dedupKey = m.matchedPr !== null
        ? `pr:${m.matchedPr}`
        : m.matchedCommit
          ? `commit:${m.matchedCommit}`
          : `thread:${normalizeForMatch(m.thread.title) || m.thread.title}`;
      if (resolvedNoSpecKeysSeen.has(dedupKey)) continue;
      resolvedNoSpecKeysSeen.add(dedupKey);
      const cite_ids: string[] = [digestCite];
      if (m.matchedJob) cite_ids.unshift(citeIdForJob(m.matchedJob));
      const anchor = m.matchedPr !== null
        ? `PR #${m.matchedPr} merged`
        : m.matchedCommit
          ? `commit ${m.matchedCommit.slice(0, 7)}`
          : `resolved in session`;
      lenses.whats_working.push({
        claim: `${short(m.thread.title, 90)} — ${anchor}.`,
        cite_ids,
      });
      continue;
    }

    // Genuinely OPEN thread — surfaces on where_you_left_off + threads_in_flight.
    const key = normalizeForMatch(m.thread.title) || m.thread.title;
    if (openSlugsSeen.has(key)) continue;
    openSlugsSeen.add(key);
    // A session-authored `open` thread's phrasing is stronger than the ingest's guess — surface it
    // as the assistant wrote it, not with the "no matching spec yet" suffix that assumes we're guessing.
    const whereClaim = m.authorStatus === "open"
      ? short(m.thread.title, 100)
      : `${short(m.thread.title, 100)} — open, no matching spec yet.`;
    lenses.where_you_left_off.push({
      claim: whereClaim,
      cite_ids: [digestCite],
    });
    lenses.threads_in_flight.push({
      claim: short(m.thread.title, 100),
      cite_ids: [digestCite],
    });
  }

  // Also seed `where_you_left_off` from the most recent digest's resume_point when nothing else surfaced.
  const mostRecent = digestsByRecency[0];
  if (mostRecent && mostRecent.resume_point && lenses.where_you_left_off.length === 0) {
    lenses.where_you_left_off.push({
      claim: short(mostRecent.resume_point, 200),
      cite_ids: [citeIdForSession(mostRecent)],
    });
  }

  // Rabbit holes: threads the founder marked as `noise` in the digest.
  for (const d of digestsByRecency) {
    for (const t of d.threads || []) {
      if (t.status !== "noise") continue;
      if (isScriptNoise(t.title)) continue;
      lenses.rabbit_holes.push({
        claim: short(t.title, 120),
        cite_ids: [citeIdForSession(d)],
      });
    }
  }

  // Next moves: derive from any planned specs in the workspace (not yet in flight).
  // Prefer specs referenced by an OPEN thread — a thread the founder marked resolved OR whose
  // PR/commit is already merged is NOT open, so it should NOT drag its planned-parent spec up
  // the next-moves queue. Same Phase-3 resolution rules as the main lens fan-out.
  const openMatchedSlugs = new Set(
    matches
      .filter((m) => {
        if (!m.matchedSpec || isSpecSettledOrInFlight(m.matchedSpec)) return false;
        if (m.authorStatus === "resolved") return false;
        if (m.matchedPr !== null && isPrNumberMerged(specs, m.matchedPr)) return false;
        if (m.matchedCommit !== null) return false;
        return true;
      })
      .map((m) => m.matchedSpec!.slug),
  );
  const plannedSpecs = specs.filter((s) => {
    const status = deriveSpecStatus(s);
    return status === "planned" || status === "in_review";
  });
  const nextCandidates = [
    ...plannedSpecs.filter((s) => openMatchedSlugs.has(s.slug)),
    ...plannedSpecs.filter((s) => !openMatchedSlugs.has(s.slug)),
  ].slice(0, 5);
  for (const s of nextCandidates) {
    lenses.next_moves.push({
      claim: `Pick up ${s.title}.`,
      cite_ids: [citeIdForSpec(s)],
    });
  }

  // In-flight specs also count as "threads in flight" (an active build carrying the founder's context).
  for (const s of specs) {
    const status = deriveSpecStatus(s);
    if (status !== "in_progress" && status !== "in_review") continue;
    lenses.threads_in_flight.push({
      claim: `${s.title} (${status})`,
      cite_ids: [citeIdForSpec(s)],
    });
  }
  // Agent jobs currently open on a spec are the most concrete in-flight signal.
  for (const j of jobs) {
    if (j.status === "merged" || j.status === "completed" || j.status === "failed") continue;
    if (isScriptNoise(j.spec_slug)) continue;
    lenses.threads_in_flight.push({
      claim: `Build job for ${j.spec_slug} is ${j.status}.`,
      cite_ids: [citeIdForJob(j)],
    });
  }

  // Every claim must carry ≥1 cite — assertion enforced by the verification harness. Drop any zero-cite claim.
  for (const key of LENS_KEYS) {
    lenses[key] = lenses[key].filter((c) => c.cite_ids.length > 0 && c.claim.trim().length > 0);
  }

  // Dedup near-identical claims + cap each lens to a BRIEFING size. The join emits one item per thread
  // across up to 40 digests → a ~160-claim firehose that (a) reads as noise, not a pulse, and (b) blows the
  // narrate pass's 2400-token output budget → the JSON truncates → silent deterministic fallback. Digests
  // arrive newest-first, so keep the most recent, merging the cite ids of any collapsed duplicate.
  const LENS_CAPS: Record<keyof PulseLenses, number> = {
    whats_working: 8,
    where_you_left_off: 10,
    rabbit_holes: 6,
    next_moves: 5,
    threads_in_flight: 10,
  };
  for (const key of LENS_KEYS) {
    const seen = new Map<string, LensClaim>();
    for (const c of lenses[key]) {
      const norm = normalizeForMatch(c.claim);
      const prev = seen.get(norm);
      if (prev) {
        for (const id of c.cite_ids) if (!prev.cite_ids.includes(id)) prev.cite_ids.push(id);
      } else {
        seen.set(norm, { claim: c.claim, cite_ids: [...c.cite_ids] });
      }
    }
    lenses[key] = [...seen.values()].slice(0, LENS_CAPS[key]);
  }

  return {
    subject,
    lenses,
    cites,
    synthesized_at: opts?.nowIso || new Date().toISOString(),
    model: "deterministic",
  };
}

/**
 * OPTIONAL LLM narrative pass. Rewrites each lens's claims in the founder's voice
 * FROM the structured evidence, preserving every claim's `cite_ids`. If the model
 * returns a claim without a valid cite_id (or the API is unavailable) we drop back
 * to the deterministic prose so the surface never grows a free-floating assertion.
 */
export async function narrateWithModel(base: PulseSnapshot, model = HAIKU_MODEL): Promise<PulseSnapshot> {
  if (!ANTHROPIC_API_KEY) return base;
  // Feed the model the deterministic lenses + cite table; ask it for a compact rewrite.
  const system = `You rewrite a founder's pulse dashboard in the founder's voice. You receive five lenses (arrays of claims) plus a cite table. Rewrite each claim to be tighter and more direct — never add new claims and never drop existing ones. Every rewritten claim MUST keep at least one cite id from the input. Return ONLY JSON: { "whats_working": [{claim,cite_ids}], "where_you_left_off": [...], "rabbit_holes": [...], "next_moves": [...], "threads_in_flight": [...] }.`;
  const user = JSON.stringify({ lenses: base.lenses, cites: base.cites }, null, 2);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 2400, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return base;
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: unknown };
    const raw = (json.content?.[0]?.text || "").replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first < 0 || last <= first) return base;
    const parsed = JSON.parse(raw.slice(first, last + 1)) as Partial<PulseLenses>;
    const merged: PulseLenses = { ...base.lenses };
    for (const key of LENS_KEYS) {
      const arr = parsed[key];
      if (!Array.isArray(arr)) continue;
      const kept: LensClaim[] = [];
      for (const c of arr) {
        if (!c || typeof c.claim !== "string" || !Array.isArray(c.cite_ids)) continue;
        const validCites = c.cite_ids.filter((id) => typeof id === "string" && base.cites[id]);
        if (validCites.length === 0) continue;
        kept.push({ claim: c.claim.trim(), cite_ids: validCites });
      }
      if (kept.length > 0) merged[key] = kept;
    }
    return { ...base, lenses: merged, model };
  } catch {
    return base;
  }
}

/**
 * Read digests + specs + open jobs and produce a snapshot. When `narrate: true`
 * (the default) an LLM pass is attempted; on any failure the deterministic
 * synthesis is what ships.
 */
export async function buildPulse(opts: {
  workspaceId: string;
  subject?: string;
  narrate?: boolean;
  admin?: ReturnType<typeof createAdminClient>;
}): Promise<PulseSnapshot> {
  const admin = opts.admin || createAdminClient();
  const [digestRows, specs, jobRows] = await Promise.all([
    admin
      .from("pulse_session_digests")
      .select("id, session_id, intent, resume_point, last_activity_at, decisions, threads, refs, digest_model")
      .eq("workspace_id", opts.workspaceId)
      .order("last_activity_at", { ascending: false })
      .limit(40),
    // spec-read-egress-scope-and-cursor: a session thread routinely references a spec that just
    // FOLDED (that's what "shipped" looks like), and matchThreadsToSpecs resolves those to DONE —
    // so this must stay folded-inclusive. Stated explicitly rather than riding the default.
    getAllSpecs(opts.workspaceId),
    admin
      .from("agent_jobs")
      .select("id, spec_slug, status, pr_number, pr_url, updated_at")
      .eq("workspace_id", opts.workspaceId)
      .in("status", ["queued", "claimed", "building", "needs_input", "needs_approval", "queued_resume", "blocked_on_usage", "needs_attention"])
      .order("updated_at", { ascending: false })
      .limit(50),
  ]);
  if (digestRows.error) throw new Error(`buildPulse digests: ${digestRows.error.message}`);
  if (jobRows.error) throw new Error(`buildPulse jobs: ${jobRows.error.message}`);
  const digests: DigestInput[] = (digestRows.data || []).map((r) => ({
    id: r.id as string,
    session_id: r.session_id as string,
    intent: (r.intent as string | null) ?? null,
    resume_point: (r.resume_point as string | null) ?? null,
    last_activity_at: (r.last_activity_at as string | null) ?? null,
    decisions: Array.isArray(r.decisions) ? (r.decisions as DigestDecision[]) : [],
    threads: Array.isArray(r.threads) ? (r.threads as DigestThread[]) : [],
    refs: Array.isArray(r.refs) ? (r.refs as DigestRef[]) : [],
    digest_model: (r.digest_model as string | null) ?? null,
  }));
  const jobs: JobInput[] = (jobRows.data || []).map((j) => ({
    id: j.id as string,
    spec_slug: j.spec_slug as string,
    status: j.status as string,
    pr_number: (j.pr_number as number | null) ?? null,
    pr_url: (j.pr_url as string | null) ?? null,
    updated_at: (j.updated_at as string | null) ?? null,
  }));
  const base = synthesizeDeterministic({ digests, specs, jobs }, { subject: opts.subject });
  const narrate = opts.narrate !== false;
  return narrate ? await narrateWithModel(base) : base;
}

/**
 * Upsert a snapshot into public.pulse_snapshots keyed on (workspace_id, subject).
 * Returns the persisted `synthesized_at` so callers can render the header stamp
 * without a follow-up read.
 */
export async function persistPulseSnapshot(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  snapshot: PulseSnapshot,
): Promise<{ synthesized_at: string }> {
  const now = snapshot.synthesized_at || new Date().toISOString();
  const { error } = await admin
    .from("pulse_snapshots")
    .upsert(
      {
        workspace_id: workspaceId,
        subject: snapshot.subject,
        lenses: snapshot.lenses,
        cites: snapshot.cites,
        synthesized_at: now,
        model: snapshot.model,
      },
      { onConflict: "workspace_id,subject" },
    );
  if (error) throw new Error(`persistPulseSnapshot: ${error.message}`);
  return { synthesized_at: now };
}

/** Latest cached snapshot for a workspace/subject, or null when none has been computed yet. */
export async function getPulseSnapshot(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  subject: string = "founder",
): Promise<PulseSnapshot | null> {
  const { data, error } = await admin
    .from("pulse_snapshots")
    .select("subject, lenses, cites, synthesized_at, model")
    .eq("workspace_id", workspaceId)
    .eq("subject", subject)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    subject: data.subject as string,
    lenses: data.lenses as PulseLenses,
    cites: (data.cites as Record<string, Cite>) || {},
    synthesized_at: data.synthesized_at as string,
    model: (data.model as string | null) || "deterministic",
  };
}

/** Log Anthropic usage for a narrative pass. Best-effort; never throws. */
export async function logPulseUsage(workspaceId: string, model: string, usage: unknown): Promise<void> {
  if (!usage) return;
  try {
    await logAiUsage({ workspaceId, model, usage: usage as never, purpose: "pulse_narrative", ticketId: null });
  } catch {
    // logAiUsage already swallows.
  }
}
