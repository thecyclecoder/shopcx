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
import { listSpecs, type SpecRow, type SpecStatus } from "@/lib/specs-table";
import { HAIKU_MODEL } from "@/lib/ai-models";
import { logAiUsage } from "@/lib/ai-usage";
import type { DigestThread, DigestRef, DigestDecision } from "@/lib/pulse-digest";

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

interface ThreadMatch {
  thread: DigestThread;
  digest: DigestInput;
  matchedSpec: SpecRow | null;
}

/**
 * For every thread across every digest, find the spec that most likely
 * matches by slug substring in the thread's title or its cite. Threads
 * pointing at script-noise or with no textual anchor at all are ignored.
 */
export function matchThreadsToSpecs(digests: DigestInput[], specs: SpecRow[]): ThreadMatch[] {
  const out: ThreadMatch[] = [];
  const bySlug = new Map<string, SpecRow>();
  const slugs = specs.map((s) => s.slug);
  for (const s of specs) bySlug.set(s.slug, s);
  slugs.sort((a, b) => b.length - a.length); // longest first so `founder-pulse-v2` wins over `founder-pulse`
  for (const digest of digests) {
    for (const thread of digest.threads || []) {
      if (isScriptNoise(thread.title) || isScriptNoise(thread.cite)) continue;
      const haystack = [thread.title, thread.cite, ...(digest.refs || []).map((r) => r.value)]
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .map((v) => normalizeForMatch(v))
        .join(" ");
      let matched: SpecRow | null = null;
      for (const slug of slugs) {
        if (haystack.includes(slug)) {
          matched = bySlug.get(slug) || null;
          break;
        }
      }
      out.push({ thread, digest, matchedSpec: matched });
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

  const matches = matchThreadsToSpecs(digestsByRecency, specs);
  const resolvedSlugsSeen = new Set<string>();
  const openSlugsSeen = new Set<string>();

  for (const m of matches) {
    const digest = m.digest;
    const digestCite = citeIdForSession(digest);
    // A thread pointing at a settled/in-flight spec is RESOLVED — it goes under what's_working, NOT where_you_left_off.
    if (m.matchedSpec && isSpecSettledOrInFlight(m.matchedSpec)) {
      const specCite = citeIdForSpec(m.matchedSpec);
      const specStatus = deriveSpecStatus(m.matchedSpec);
      if (!resolvedSlugsSeen.has(m.matchedSpec.slug)) {
        resolvedSlugsSeen.add(m.matchedSpec.slug);
        lenses.whats_working.push({
          claim: `${m.matchedSpec.title} is ${specStatus === "folded" || specStatus === "shipped" ? specStatus : "in flight"} (started as “${short(m.thread.title, 60)}”).`,
          cite_ids: [specCite, digestCite],
        });
      }
      continue;
    }
    // Otherwise it's a genuinely OPEN thread — surfaces on where_you_left_off + threads_in_flight.
    if (m.thread.status === "noise") continue;
    const key = normalizeForMatch(m.thread.title) || m.thread.title;
    if (openSlugsSeen.has(key)) continue;
    openSlugsSeen.add(key);
    lenses.where_you_left_off.push({
      claim: `${short(m.thread.title, 100)} — open, no matching spec yet.`,
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
  // Prefer specs referenced by an open thread; fall back to the newest planned specs.
  const openMatchedSlugs = new Set(
    matches.filter((m) => m.matchedSpec && !isSpecSettledOrInFlight(m.matchedSpec)).map((m) => m.matchedSpec!.slug),
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
      body: JSON.stringify({ model, max_tokens: 1400, system, messages: [{ role: "user", content: user }] }),
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
      .select("id, session_id, intent, resume_point, last_activity_at, decisions, threads, refs")
      .eq("workspace_id", opts.workspaceId)
      .order("last_activity_at", { ascending: false })
      .limit(40),
    listSpecs(opts.workspaceId),
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
