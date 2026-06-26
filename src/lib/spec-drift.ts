/**
 * spec-drift — keep a spec's phase status in sync with shipped code (spec-drift-agent spec).
 *
 * Builds keep merging without their `spec_phases.status` advancing to `shipped`, so shipped work parks
 * in the Planned/In-progress columns. This module is the per-phase, EVIDENCE-GATED reconciler that closes
 * that drift. It NEVER guesses "merged ⇒ done": for each phase it weighs two independent signals —
 *
 *   1. a merged `kind='build'` agent_job for the spec (the work was actually shipped), and
 *   2. the phase's claimed code is verifiably on `main` (every file path / migration its body names exists).
 *
 * and acts per-phase:
 *   - merged build  AND all named code on main, status still planned/in_progress → AUTO-STAMP shipped
 *     (via `stampPhaseShipped` — the only status-write surface).
 *   - all named code on main but NO merged build on record (can't be confident it was this phase's
 *     deliberate ship) → SURFACE it as drift for a one-tap owner flip (never a wrong auto-flip).
 *   - code not fully on main, or the phase names no verifiable paths → LEAVE it (genuinely unbuilt:
 *     a fan-out phase, a deferred follow-on). This is the guardrail against over-flagging multi-phase
 *     specs with real pending later phases.
 *
 * DB-only data flow (retire-md-reads-from-pm-flow Phase 2): reads the spec via [[specs-table]] `getSpec`
 * — `spec_phases[i].body` for code-path extraction, `spec_phases[i].status` for the per-phase decision.
 * NO `docs/brain/specs/*.md` HTTP fetch, NO markdown parse. The status writeback is `stampPhaseShipped`
 * on the canonical `spec_phases` row; nothing rewrites a markdown body anymore. The spec's column then
 * follows from the rollup readers (`rollupPhaseStatus` over the post-stamp phase set) — a spec is
 * "shipped" only when EVERY phase is shipped.
 *
 * Two triggers (same engine): the build-merge path ([[agent-jobs]] `applyMergedBuildEffects`, the root
 * fix — Part A) and a Control-Tower self-audit cron backstop (spec-drift-reconcile — Part B). Surfaced
 * drift lands in the `spec_drift` table, rendered on the Control Tower for a one-tap flip. See
 * docs/brain/libraries/spec-drift.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { listArchivedSlugs, phaseEmoji, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { rollupPhaseStatus } from "@/lib/spec-card-state";
import { getSpec, stampPhaseShipped, type SpecPhaseRow } from "@/lib/specs-table";

const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
function ghToken(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;
}

async function gh(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

// ── Phase shape (DB row → drift-reconciler view) ─────────────────────────────────────────────────

/** One phase as the reconciler sees it — the typed `spec_phases` row projected to the fields drift work uses. */
export interface DriftPhase {
  index: number; // 0-based — matches the board parser order + /api/roadmap/spec-drift phaseIndex
  position: number; // 1-based — the canonical `spec_phases.position` for the writeback stamp
  title: string;
  status: Phase;
  body: string; // the phase's text — what we scan for code paths
}

function driftPhasesFromRows(rows: SpecPhaseRow[]): DriftPhase[] {
  return rows
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((p, i) => ({ index: i, position: p.position, title: p.title, status: p.status, body: p.body }));
}

// ── Code-on-main verification ────────────────────────────────────────────────────────────────────

// Path-like tokens the phase body names. We require a known top-level dir so prose doesn't false-match,
// plus bare migration filenames (referenced without the supabase/migrations/ prefix).
// Only the repo's real top-level dirs — a bare `lib/x.ts` (no such root here) would never exist on main
// and would wrongly drag a phase's allOnMain to false, suppressing a legit flip. Keep this tight.
const PATH_RE = /(?:src|supabase|scripts|remotion|shopify-extension|public|docs)\/[\w./@-]+\.[a-z]{1,5}/gi;
const MIGRATION_RE = /\b(\d{14}_[\w-]+\.sql)\b/g;

/** Distinct code paths a phase claims to have shipped (file paths + bare migration filenames). */
export function extractCodePaths(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(PATH_RE)) {
    // Trim trailing punctuation the regex's char class might have swept up (none here) — keep as-is.
    out.add(m[0]);
  }
  for (const m of body.matchAll(MIGRATION_RE)) {
    out.add(`supabase/migrations/${m[1]}`);
  }
  return [...out];
}

/** Does a path exist on `main`? Cached per-run so repeated paths across phases hit GitHub once. */
async function pathExistsOnMain(path: string, cache: Map<string, boolean>): Promise<boolean> {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  let exists = false;
  try {
    const res = await gh("GET", `/repos/${REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=main`);
    exists = res.ok;
  } catch {
    exists = false;
  }
  cache.set(path, exists);
  return exists;
}

// ── Reconciler ─────────────────────────────────────────────────────────────────────────────────────

export interface SpecDriftRow {
  id: string;
  spec_slug: string;
  phase_index: number;
  phase_title: string;
  current_emoji: string;
  detail: string;
  status: "open" | "resolved";
  opened_at: string;
  last_seen_at: string;
}

/** Mark a spec_drift row resolved (e.g. after the director confirms the phase shipped + flips it ✅). */
export async function resolveDriftRow(admin: ReturnType<typeof createAdminClient>, id: string): Promise<void> {
  await admin.from("spec_drift").update({ status: "resolved", last_seen_at: new Date().toISOString() }).eq("id", id);
}

export interface ReconcileResult {
  slug: string;
  flipped: { index: number; title: string }[]; // phases auto-stamped shipped this run
  surfaced: { index: number; title: string }[]; // phases left for a one-tap owner flip (open drift rows)
  status: SpecStatus; // derived spec status after any stamps
  reason?: string; // why nothing happened (no token / no spec row / no phases)
}

interface ReconcileOpts {
  /** Pre-fetched map of spec slug → merged build PR # for the cron sweep (a single `agent_jobs` query). */
  mergedBuildBySlug?: Map<string, { pr: number | null }>;
}

/** Look up the most recent merged `kind='build'` job for this spec — returns its PR # (or null). */
async function findMergedBuild(workspaceId: string, slug: string): Promise<{ pr: number | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("pr_number")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .eq("status", "merged")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!data || !data.length) return null;
  const pr = (data[0] as { pr_number: number | null }).pr_number;
  return { pr: typeof pr === "number" ? pr : null };
}

/**
 * Reconcile ONE spec's phase status against code-on-main + merged-build evidence (the engine both
 * triggers share). Reads the spec from the DB ([[specs-table]] `getSpec`), auto-stamps confident phases
 * via `stampPhaseShipped`, upserts/clears `spec_drift` rows for the ambiguous ones, and returns what
 * it did. Never throws — best-effort, returns a reason on skip.
 */
export async function reconcileSpecDrift(workspaceId: string, slug: string, opts: ReconcileOpts = {}): Promise<ReconcileResult> {
  const empty = (reason: string): ReconcileResult => ({ slug, flipped: [], surfaced: [], status: "planned", reason });
  if (!/^[a-z0-9-]+$/i.test(slug)) return empty("invalid slug");
  if (!ghToken()) return empty("no GitHub token");

  // DB-only spec read (retire-md-reads-from-pm-flow Phase 2). `spec_phases[i].body` is the code-path
  // source; `spec_phases[i].status` is the seed. No `docs/brain/specs/*.md` HTTP fetch / markdown parse.
  const spec = await getSpec(workspaceId, slug);
  if (!spec) return empty("spec not in DB");
  if (spec.status === "folded") return empty("spec folded — nothing to reconcile");
  const phases = driftPhasesFromRows(spec.phases);
  // A one-shot spec (no phases) has nothing to reconcile per-phase. The status it already carries IS
  // the truth (the merge hook wrote it). Coerce to the brain-roadmap SpecStatus shape — `folded` was
  // filtered above, so the remaining values overlap exactly.
  if (!phases.length) return { slug, flipped: [], surfaced: [], status: spec.status as SpecStatus, reason: "no phases" };

  const mergedBuild =
    opts.mergedBuildBySlug !== undefined ? (opts.mergedBuildBySlug.get(slug) ?? null) : await findMergedBuild(workspaceId, slug);

  const cache = new Map<string, boolean>();
  const flipped: { index: number; title: string; position: number }[] = [];
  const surfaced: { index: number; phase: DriftPhase }[] = [];

  // Decide per stale phase (anything not already shipped and not an explicit `rejected` cut).
  for (const phase of phases) {
    if (phase.status === "shipped" || phase.status === "rejected") continue;
    const paths = extractCodePaths(phase.body);
    if (paths.length === 0) continue; // nothing to verify → can't be confident → leave (genuinely unbuilt)
    const checks = await Promise.all(paths.map((p) => pathExistsOnMain(p, cache)));
    const allOnMain = checks.every(Boolean);
    if (!allOnMain) continue; // code not (fully) on main → genuinely unbuilt / fan-out / mid-build → leave

    if (mergedBuild) {
      flipped.push({ index: phase.index, title: phase.title, position: phase.position }); // confident: stamp shipped
    } else {
      surfaced.push({ index: phase.index, phase }); // code on main but no merged build on record → surface
    }
  }

  // Stamp each confident phase shipped on the canonical `spec_phases` row. Best-effort per phase so a
  // single failure doesn't block the rest — the next sweep re-attempts the remainder. Provenance: the
  // merged build's PR # + the resolved merge SHA when we can fetch it. Falling back to nulls is safe
  // because a phase whose status isn't shipped also has no prior pr/merge_sha to clobber.
  const mergeSha = mergedBuild?.pr ? await resolvePrMergeSha(mergedBuild.pr) : null;
  for (const f of flipped) {
    try {
      await stampPhaseShipped(workspaceId, slug, f.position, { pr: mergedBuild?.pr ?? null, merge_sha: mergeSha });
    } catch {
      /* leaf write failed — leave it for the next sweep */
    }
  }

  await syncDriftRows(workspaceId, slug, surfaced);

  // Roll the post-stamp phase set up to a derived status — the same shape the board renderer reads.
  const postStampPhases = phases.map((p) =>
    flipped.some((f) => f.position === p.position) ? { ...p, status: "shipped" as Phase } : p,
  );
  const status: SpecStatus = rollupPhaseStatus(
    postStampPhases.map((p) => ({ index: p.index, title: p.title, status: p.status })),
  );

  return { slug, flipped: flipped.map((f) => ({ index: f.index, title: f.title })), surfaced: surfaced.map((s) => ({ index: s.phase.index, title: s.phase.title })), status };
}

/** Upsert open `spec_drift` rows for the surfaced phases; resolve any open row no longer surfaced. */
async function syncDriftRows(workspaceId: string, slug: string, surfaced: { index: number; phase: DriftPhase }[]): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const keep = new Set(surfaced.map((s) => s.phase.index));

  for (const s of surfaced) {
    const detail = `${slug} — P${s.phase.index + 1} (${s.phase.title}) code is on main but still ${phaseEmoji(s.phase.status)} — no merged build on record, owner confirm.`;
    // Upsert one open row per (workspace, slug, phase): bump if it exists, insert if not.
    const { data: existing } = await admin
      .from("spec_drift")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("phase_index", s.phase.index)
      .eq("status", "open")
      .limit(1);
    if (existing && existing.length) {
      await admin
        .from("spec_drift")
        .update({ last_seen_at: nowIso, phase_title: s.phase.title, current_emoji: phaseEmoji(s.phase.status), detail })
        .eq("id", (existing[0] as { id: string }).id);
    } else {
      await admin
        .from("spec_drift")
        .insert({
          workspace_id: workspaceId,
          spec_slug: slug,
          phase_index: s.phase.index,
          phase_title: s.phase.title,
          current_emoji: phaseEmoji(s.phase.status),
          detail,
          status: "open",
        })
        .then(undefined, () => {}); // partial-unique race backstop — ignore a 23505
    }
  }

  // Resolve open rows for this spec that are no longer drifting (flipped / now on main with a build).
  const { data: open } = await admin
    .from("spec_drift")
    .select("id, phase_index")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("status", "open");
  for (const row of (open ?? []) as { id: string; phase_index: number }[]) {
    if (keep.has(row.phase_index)) continue;
    await admin.from("spec_drift").update({ status: "resolved", resolved_at: nowIso }).eq("id", row.id);
  }
}

export interface DriftSweepResult {
  specsScanned: number;
  flipped: number;
  surfaced: number;
}

// ── Self-heal "built-unstamped" phases (repurpose-spec-drift-reconciler P1) ─────────────────────────

/**
 * The strong, single signal that a spec is "built but unstamped": the box's build/fold job no-op'd as
 * "already-shipped" — it found the WHOLE spec's work already merged on `main` (via a sibling build) and
 * terminated WITHOUT opening a PR or touching files. The error/log_tail carries `already merged via #N`
 * (the build claim-dedup at builder-worker.ts `findMergedSiblingBuild`, and the dirty-PR duplicate close).
 * That outcome IS Bo's implicit report: the spec is on main, the phase just never got stamped (a backfill
 * seeded it `planned`). We only trust THIS message — never the looser "no changes" outcome (which matched a
 * genuinely-empty-phase spec, agents-hub-role-inboxes), so an incomplete spec is never over-stamped.
 */
const ALREADY_MERGED_VIA_RE = /already merged via #(\d+)/i;

/**
 * The SECOND built-unstamped signal — the RE-QUEUE case. When an owner re-queues an ALREADY-BUILT phase,
 * Bo's pre-flight state-check finds every artifact for that phase already on `main`, makes zero edits, and
 * the build terminates `status='needs_attention'` with a PHASE-SPECIFIC report like:
 *
 *   "All Phase-5 artifacts already exist on main: src/app/dashboard/agents/…"
 *
 * (Bo's emitted `no_changes_reason`/`summary`, surfaced into the job's `error`/`log_tail` at the no-PR/
 * no-change path in builder-worker.ts — line ~10672. This is what happened to agents-hub-role-inboxes.)
 *
 * Unlike the `already merged via #N` signal (whole spec, carries a PR), this one is per-PHASE and carries
 * NO PR — the heal IS the point. We match ONLY this explicit phase-specific wording (never a looser "no
 * changes") and capture the phase NUMBER N, then stamp ONLY position N. Conservative + idempotent: a re-run
 * finds the phase already shipped (so it never re-stamps), and a malformed/looser report never matches.
 */
const PHASE_ARTIFACTS_EXIST_RE = /All Phase[\s-]?(\d+)[\s-]?artifacts already exist on main/i;

/**
 * The THIRD, GENERAL built-unstamped signal — heal-any-box-parked-already-built. Bo parks a re-built
 * phase `needs_attention` with VARYING wordings beyond the two specific ones above: "Phase 2 already on
 * main — …", "already-shipped: {slug} already merged via #X", "All Phase-5 artifacts already exist on
 * main: …", "no changes" / "no file changes", etc. This broad matcher catches the whole family so a
 * parked-already-built job no longer slips through to pile up as needs_attention (→ Ada re-escalates →
 * operator hand-stamps). It is INTENTIONALLY loose on the SIGNAL but STRICT on the ACTION: a match only
 * triggers a stamp of the ONE phase the build was dispatched for (parsed from the job's `instructions`,
 * never a blanket all-non-shipped stamp — a real incident came from over-stamping a multi-phase spec, so
 * per-phase precision is the hard guardrail here).
 */
const ALREADY_BUILT_BROAD_RE = /already (on main|merged|built|shipped)|artifacts already exist|no (file )?changes/i;

/**
 * Parse the DISPATCHED phase number from a build job's text. PRIMARY source is the job's `instructions`
 * (the build was dispatched FOR that phase — `phaseScopedInstructions` embeds `"Phase N — <title>"`);
 * FALLBACK is the parked log message. We take the FIRST `Phase <N>` either yields (regex ported from
 * builder-worker.ts `derivePhase`). Returns null when neither names a phase — the caller then SKIPS the
 * job (never guesses / never defaults to position 1), the per-phase-precision guard.
 */
function dispatchedPhaseNumber(instructions: string | null | undefined, log: string | null | undefined): number | null {
  const PHASE_RE = /\bPhase\s+(\d+)\b/i;
  const fromInstr = instructions ? PHASE_RE.exec(instructions) : null;
  if (fromInstr) return Number(fromInstr[1]);
  const fromLog = log ? PHASE_RE.exec(log) : null;
  if (fromLog) return Number(fromLog[1]);
  return null;
}

/** Cheap PR → merge-commit SHA resolution via the existing GitHub REST helper. Null on any miss. */
async function resolvePrMergeSha(pr: number): Promise<string | null> {
  try {
    const res = await gh("GET", `/repos/${REPO}/pulls/${pr}`);
    if (!res.ok) return null;
    const sha = res.json.merge_commit_sha;
    return typeof sha === "string" && sha ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Self-heal "built-unstamped" phases — the supervising-agent half of the box's "already-shipped" no-op.
 *
 * THE LOOP THIS CLOSES: after the db-driven-specs cutover, spec status is DERIVED from `spec_phases`. The
 * backfill seeded some phases `planned` even though their work had already merged. When the box later builds
 * such a phase, `runJob` finds the work already on `main`, terminates "already merged via #N" with NO file
 * changes — and the phase STAYS `planned`. The board keeps showing it un-built and re-invites a phantom
 * rebuild (the box starts, finds nothing, stops). Forever.
 *
 * THE FIX (conservative — only the strong signal): a spec qualifies iff (a) it has ≥1 `spec_phases` row whose
 * status is NOT 'shipped'/'rejected', AND (b) it has a recent `agent_jobs` row (kind build|fold, status
 * merged|completed) whose `error`/`log_tail` matches `already merged via #N` — the box CONFIRMING the whole
 * spec is already on main. For each match we stamp EVERY non-shipped, non-rejected phase `shipped` via
 * `stampPhaseShipped` (the canonical leaf write that advances the DERIVED status — the rollup trigger is
 * gone), tagging `pr` (the key provenance) + a best-effort `merge_sha`, and log ONE supervisor-visible
 * `director_activity` row per healed spec. Idempotent: a second run finds no qualifying phases.
 *
 * SINGLE-WORKSPACE by contract — the caller passes the canonical PM workspace; this never iterates workspaces.
 */
export async function healBuiltUnstampedPhases(workspaceId: string): Promise<{ slug: string; phases: number[]; pr: number }[]> {
  const admin = createAdminClient();

  // (a) Candidate specs: any with ≥1 phase NOT IN ('shipped','rejected'). One read, joined to phases.
  const { data: phaseRows } = await admin
    .from("spec_phases")
    .select("position, status, specs!inner(slug, workspace_id)")
    .eq("specs.workspace_id", workspaceId)
    .not("status", "in", "(shipped,rejected)");
  type Row = { position: number; status: Phase; specs: { slug: string; workspace_id: string } | { slug: string; workspace_id: string }[] };
  const unstampedBySlug = new Map<string, number[]>();
  for (const r of (phaseRows ?? []) as Row[]) {
    const spec = Array.isArray(r.specs) ? r.specs[0] : r.specs;
    if (!spec?.slug) continue;
    const list = unstampedBySlug.get(spec.slug) ?? [];
    list.push(r.position);
    unstampedBySlug.set(spec.slug, list);
  }
  if (!unstampedBySlug.size) return [];

  // (b) For each candidate, find a recent build/fold job the box no-op'd as "already merged via #N".
  const healed: { slug: string; phases: number[]; pr: number }[] = [];
  for (const [slug, positions] of unstampedBySlug) {
    const { data: jobs } = await admin
      .from("agent_jobs")
      .select("error, log_tail, status")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .in("kind", ["build", "fold"])
      .in("status", ["merged", "completed"])
      .order("created_at", { ascending: false })
      .limit(5);
    let pr: number | null = null;
    for (const j of (jobs ?? []) as { error: string | null; log_tail: string | null }[]) {
      const m = `${j.error ?? ""}\n${j.log_tail ?? ""}`.match(ALREADY_MERGED_VIA_RE);
      if (m) {
        pr = Number(m[1]);
        break;
      }
    }
    if (pr === null) continue; // no strong "already-shipped" signal → leave (could be genuinely incomplete)

    // Stamp every non-shipped, non-rejected phase shipped — the leaf write that advances the derived status.
    const mergeSha = await resolvePrMergeSha(pr);
    const stamped: number[] = [];
    for (const position of positions.sort((a, b) => a - b)) {
      try {
        await stampPhaseShipped(workspaceId, slug, position, { pr, merge_sha: mergeSha });
        stamped.push(position);
      } catch {
        /* a single phase write failing must not block the rest; the next sweep re-attempts the remainder */
      }
    }
    if (!stamped.length) continue;
    healed.push({ slug, phases: stamped, pr });

    // Supervisor-visible report: one director_activity row naming the spec + phases healed + the PR.
    try {
      const { recordDirectorActivity } = await import("@/lib/director-activity");
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction: "platform",
        actionKind: "healed_built_unstamped",
        specSlug: slug,
        reason: `reconciler:spec-drift stamped ${stamped.length} built-but-unstamped phase(s) (P${stamped.join(", P")}) of ${slug} shipped — the box confirmed the whole spec already merged via #${pr} (no file changes), so the backfilled-planned phase(s) were never advanced. Self-healed the derived status.`,
        metadata: { actor: "reconciler:spec-drift", pr, merge_sha: mergeSha, phases: stamped },
      });
    } catch {
      /* audit is best-effort — the stamp already landed */
    }
  }

  // (c) SECOND signal — the RE-QUEUE case. For each candidate, look for a recent build job the box parked
  // `needs_attention` because Bo found a SPECIFIC phase's artifacts already on main ("All Phase-N artifacts
  // already exist on main: …"). Per-phase, carries no PR — stamp ONLY position N, then clear the stuck card.
  for (const [slug, positions] of unstampedBySlug) {
    const unstamped = new Set(positions);
    const { data: naJobs } = await admin
      .from("agent_jobs")
      .select("id, error, log_tail")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("kind", "build")
      .eq("status", "needs_attention")
      .order("created_at", { ascending: false })
      .limit(5);
    for (const j of (naJobs ?? []) as { id: string; error: string | null; log_tail: string | null }[]) {
      const m = `${j.error ?? ""}\n${j.log_tail ?? ""}`.match(PHASE_ARTIFACTS_EXIST_RE);
      if (!m) continue;
      const n = Number(m[1]);
      // Only stamp if N is a real, still-unstamped phase for this spec (idempotent: a re-run finds it shipped
      // and unstamped no longer holds N → we skip + still clear the card). This signal carries no PR.
      if (!unstamped.has(n)) {
        // Phase already shipped (idempotent re-run) — but the needs_attention card may still be stuck. Clear it.
        await admin.from("agent_jobs").update({ status: "completed" }).eq("id", j.id).then(undefined, () => {});
        continue;
      }
      let ok = false;
      try {
        await stampPhaseShipped(workspaceId, slug, n, { pr: null, merge_sha: null });
        ok = true;
      } catch {
        /* stamp failed — leave the card; the next sweep re-attempts */
      }
      if (!ok) continue;
      unstamped.delete(n);

      // Clear the stuck needs_attention card now that its phase is reconciled.
      await admin.from("agent_jobs").update({ status: "completed" }).eq("id", j.id).then(undefined, () => {});

      const existing = healed.find((h) => h.slug === slug);
      if (existing) existing.phases.push(n);
      else healed.push({ slug, phases: [n], pr: -1 });

      // Supervisor-visible report — same shape as the already-merged branch, naming the re-queue signal.
      try {
        const { recordDirectorActivity } = await import("@/lib/director-activity");
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: "platform",
          actionKind: "healed_built_unstamped",
          specSlug: slug,
          reason: `reconciler:spec-drift stamped built-but-unstamped phase P${n} of ${slug} shipped — a re-queued build hit Bo's "All Phase-${n} artifacts already exist on main" no-op (status=needs_attention, no PR, no file changes), so the backfilled-planned phase was never advanced. Self-healed the derived status and cleared the stuck card.`,
          metadata: { actor: "reconciler:spec-drift", signal: "phase-artifacts-already-exist", pr: null, merge_sha: null, phase: n, job_id: j.id },
        });
      } catch {
        /* audit is best-effort — the stamp already landed */
      }
    }
  }

  // (d) THIRD signal — the GENERAL parked-already-built case. The two branches above match only two
  // specific wordings; Bo parks an already-built rebuild `needs_attention` with many OTHER wordings
  // ("Phase 2 already on main — …", "already merged via #X", "no changes", …). Catch the whole family
  // with ALREADY_BUILT_BROAD_RE so none slip through to pile up as needs_attention. PER-PHASE PRECISION
  // is the hard rule: stamp ONLY the phase the build was DISPATCHED for (parsed from the job's
  // `instructions`, log as fallback) — NEVER a blanket all-non-shipped stamp (a real over-stamp incident
  // came from that). If no phase can be parsed, SKIP the job. Idempotent: a re-run finds N already
  // shipped → skip the stamp but still clear the lingering parked card.
  for (const [slug, positions] of unstampedBySlug) {
    const unstamped = new Set(positions);
    const { data: naJobs } = await admin
      .from("agent_jobs")
      .select("id, error, log_tail, instructions")
      .eq("workspace_id", workspaceId)
      .eq("spec_slug", slug)
      .eq("kind", "build")
      .eq("status", "needs_attention")
      .order("created_at", { ascending: false })
      .limit(5);
    for (const j of (naJobs ?? []) as { id: string; error: string | null; log_tail: string | null; instructions: string | null }[]) {
      const log = `${j.error ?? ""}\n${j.log_tail ?? ""}`;
      if (!ALREADY_BUILT_BROAD_RE.test(log)) continue; // not an "already built" park → leave it for Ada

      // Per-phase precision: the dispatched phase is reliably named in `instructions` ("Phase N — …");
      // the log is a fallback. No number from either → SKIP (never guess / never default to position 1).
      const n = dispatchedPhaseNumber(j.instructions, log);
      if (n === null) continue;

      // Idempotent: a re-run (or a phase already shipped by an earlier branch this pass) finds N no longer
      // in `unstamped` → skip the stamp but STILL clear the lingering parked card.
      if (!unstamped.has(n)) {
        await admin.from("agent_jobs").update({ status: "completed" }).eq("id", j.id).then(undefined, () => {});
        continue;
      }

      let ok = false;
      try {
        await stampPhaseShipped(workspaceId, slug, n, { pr: null, merge_sha: null });
        ok = true;
      } catch {
        /* stamp failed — leave the card; the next sweep re-attempts */
      }
      if (!ok) continue;
      unstamped.delete(n);

      // Clear the stuck needs_attention card (clears Ada's escalation) now that its phase is reconciled.
      await admin.from("agent_jobs").update({ status: "completed" }).eq("id", j.id).then(undefined, () => {});

      const existing = healed.find((h) => h.slug === slug);
      if (existing) existing.phases.push(n);
      else healed.push({ slug, phases: [n], pr: -1 });

      // Supervisor-visible report — same shape as the existing branches, naming the parked-build signal.
      try {
        const { recordDirectorActivity } = await import("@/lib/director-activity");
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: "platform",
          actionKind: "healed_built_unstamped",
          specSlug: slug,
          reason: `reconciler:spec-drift stamped built-but-unstamped phase P${n} of ${slug} shipped — a re-queued build parked needs_attention because the box found the phase already built on main (matched the general "already built" signal, no PR, no file changes). Parsed the dispatched phase from the job instructions, stamped ONLY P${n}, self-healed the derived status, and cleared the stuck card.`,
          metadata: { actor: "reconciler:spec-drift", signal: "already-built-broad", pr: null, merge_sha: null, phase: n, job_id: j.id },
        });
      } catch {
        /* audit is best-effort — the stamp already landed */
      }
    }
  }

  return healed;
}

/**
 * The DB-vs-CODE consistency backstop, plus the spec_phases anomaly sweep (repurpose-spec-drift-reconciler
 * Phase 2). Status is DERIVED from spec_phases now (the rollup trigger was dropped — derive-rollup-status
 * P3), so the reconciler NEVER writes spec_card_state.status anymore — that would only append phantom rows
 * to spec_status_history for a field nothing reads. Its remaining jobs:
 *
 *   (a) DB-vs-code: for every phase canonical `spec_phases` marks **shipped**, verify the phase's code is
 *       ACTUALLY on `main`. If a shipped phase's code paths are missing (a bad/reverted merge, a wrong DB
 *       write), surface a `spec_drift` row for the supervising director to confirm + escalate. NEVER
 *       mutates status here (surface-don't-auto-correct, North star — the leash's reversibility backstop).
 *
 *   (b) Anomaly sweep: surface genuine `spec_phases` anomalies the auto-healer can't fix — orphan rows
 *       (a spec_phases child whose parent specs row is gone), duplicate positions within a spec (the
 *       upsert spine bypassed), and provenance gaps (`status='shipped'` with both `pr` and `merge_sha`
 *       null — a stamp landed without recording the merge that shipped it). One `director_activity` row
 *       per anomaly cluster, routed to the platform director. Idempotent: a second pass finds the same
 *       anomalies and emits the same audit rows; the dashboard de-dupes by spec/kind.
 *
 * Phase bodies live in `public.spec_phases.body` (retire-md-reads-from-pm-flow Phase 2 — the PM flow
 * reads no `docs/brain/specs/*.md` anymore); the path-existence check pulls `body` straight from the
 * canonical row.
 */
export async function runSpecDriftReconciler(workspaceId: string): Promise<DriftSweepResult> {
  if (!ghToken()) return { specsScanned: 0, flipped: 0, surfaced: 0 };
  const archived = new Set(await listArchivedSlugs());
  const cache = new Map<string, boolean>();
  const suspects: { slug: string; index: number; title: string }[] = [];
  let scanned = 0;

  // (a) DB-vs-code: read the CANONICAL shipped phases from `spec_phases` (not the spec_card_state mirror)
  //     so the check tracks the truth the board derives from. `body` + `title` come from the same row —
  //     retire-md-reads-from-pm-flow Phase 2: no `docs/brain/specs/*.md` fetch + parse for the path
  //     verification, we read the typed body straight from the canonical row.
  const admin = createAdminClient();
  const { data: shippedPhaseRows } = await admin
    .from("spec_phases")
    .select("position, status, title, body, specs!inner(slug, workspace_id, status)")
    .eq("specs.workspace_id", workspaceId)
    .eq("status", "shipped");
  type ShippedRow = {
    position: number;
    status: Phase;
    title: string;
    body: string;
    specs:
      | { slug: string; workspace_id: string; status: string }
      | { slug: string; workspace_id: string; status: string }[];
  };
  const shippedBySlug = new Map<string, { position: number; title: string; body: string }[]>();
  for (const r of (shippedPhaseRows ?? []) as ShippedRow[]) {
    const spec = Array.isArray(r.specs) ? r.specs[0] : r.specs;
    if (!spec?.slug || spec.status === "folded") continue;
    if (archived.has(spec.slug)) continue;
    const list = shippedBySlug.get(spec.slug) ?? [];
    list.push({ position: r.position, title: r.title, body: r.body });
    shippedBySlug.set(spec.slug, list);
  }

  for (const [slug, rows] of shippedBySlug) {
    scanned++;
    for (const row of rows) {
      // `spec_phases.position` is 1-based; the drift surface uses 0-based `index` (matches /api/roadmap/spec-drift).
      const index = row.position - 1;
      const paths = extractCodePaths(row.body);
      if (!paths.length) continue; // no code paths declared → can't verify → trust the DB (don't false-flag)
      const checks = await Promise.all(paths.map((p) => pathExistsOnMain(p, cache)));
      if (!checks.every(Boolean)) suspects.push({ slug, index, title: row.title }); // shipped in DB, code missing on main
    }
  }
  await syncReverseDriftRows(workspaceId, suspects);

  // (b) Anomaly sweep — orphan/duplicate spec_phases rows + provenance gaps. Surface-only: one
  //     director_activity row per spec with at least one anomaly the reconciler can't auto-heal.
  await detectSpecPhaseAnomalies(workspaceId);

  return { specsScanned: scanned, flipped: 0, surfaced: suspects.length };
}

/**
 * The spec_phases anomaly sweep (repurpose-spec-drift-reconciler Phase 2). Three genuine anomalies the
 * reconciler can't auto-heal — they reflect a corrupt write upstream, not stale drift — surface to the
 * platform director as one `director_activity` row per spec / kind:
 *
 *   - ORPHAN: a spec_phases row whose parent specs row is gone (the FK ON DELETE CASCADE should kill
 *     these on parent delete, so a survivor is a data-integrity bug — probably a missing FK or a manual
 *     row insert via a one-off script).
 *
 *   - DUPLICATE POSITION: two spec_phases rows with the same (spec_id, position). The unique index
 *     should prevent this, so a survivor means the index is missing or was dropped — surface for the
 *     director to investigate, never auto-deduplicate (which of the two carries the truth?).
 *
 *   - PROVENANCE GAP: a `status='shipped'` row with both `pr` IS NULL and `merge_sha` IS NULL — a stamp
 *     landed without recording the merge that shipped it. The board's per-phase PR chip can't render
 *     and the audit trail loses the shipping commit. Surface so the director can backfill from the
 *     build job / merge hook.
 *
 * Read-only against `spec_phases` + `specs`; never mutates. Best-effort + never throws — a query failure
 * leaves the next beat to retry. Returns the count of anomaly clusters reported (one per spec/kind).
 */
export async function detectSpecPhaseAnomalies(workspaceId: string): Promise<{ orphans: number; duplicates: number; provenanceGaps: number }> {
  const admin = createAdminClient();
  let orphanReported = 0;
  let dupReported = 0;
  let gapReported = 0;

  const { recordDirectorActivity } = await import("@/lib/director-activity");

  // ORPHAN sweep: a spec_phases row whose spec_id has no parent in `specs`. Workspace gate is tricky
  // for orphans (no parent to read workspace_id from), so we read ALL spec_phases ids+spec_id and
  // intersect against the specs id set — then filter to this workspace by sampling each orphan's
  // already-known spec_id presence in the workspace's spec set. In practice an orphan is rare; this
  // sweep is the safety rail.
  try {
    const { data: allPhases } = await admin.from("spec_phases").select("id, spec_id, position, status");
    const phaseRows = (allPhases ?? []) as { id: string; spec_id: string; position: number; status: Phase }[];
    if (phaseRows.length) {
      const specIds = Array.from(new Set(phaseRows.map((p) => p.spec_id)));
      const { data: liveSpecs } = await admin
        .from("specs")
        .select("id, slug, workspace_id")
        .in("id", specIds);
      const liveById = new Map<string, { slug: string; workspace_id: string }>();
      for (const s of (liveSpecs ?? []) as { id: string; slug: string; workspace_id: string }[]) {
        liveById.set(s.id, { slug: s.slug, workspace_id: s.workspace_id });
      }
      const orphans = phaseRows.filter((p) => !liveById.has(p.spec_id));
      if (orphans.length) {
        try {
          await recordDirectorActivity(admin, {
            workspaceId,
            directorFunction: "platform",
            actionKind: "spec_phases_anomaly",
            specSlug: null,
            reason: `reconciler:spec-drift surfaced ${orphans.length} orphan spec_phases row(s) — spec_id has no parent specs row (FK cascade should have killed these on parent delete). Inspect + clean up via a one-off script.`,
            metadata: { actor: "reconciler:spec-drift", kind: "orphan", count: orphans.length, sample: orphans.slice(0, 10).map((o) => ({ id: o.id, spec_id: o.spec_id, position: o.position, status: o.status })) },
          });
          orphanReported = 1;
        } catch { /* best-effort audit */ }
      }

      // DUPLICATE POSITION sweep: same (spec_id, position) appears twice. The unique index
      // (spec_phases_spec_position) should prevent this — a survivor means the index is missing or was
      // dropped. Group by (spec_id, position) and report any cluster with >1 row.
      const byKey = new Map<string, { id: string; position: number; status: Phase }[]>();
      for (const p of phaseRows) {
        const liveSpec = liveById.get(p.spec_id);
        if (!liveSpec || liveSpec.workspace_id !== workspaceId) continue;
        const k = `${p.spec_id}#${p.position}`;
        const list = byKey.get(k) ?? [];
        list.push({ id: p.id, position: p.position, status: p.status });
        byKey.set(k, list);
      }
      const dupClusters: { slug: string; position: number; ids: string[]; statuses: Phase[] }[] = [];
      for (const [k, list] of byKey) {
        if (list.length < 2) continue;
        const [specId] = k.split("#");
        const slug = liveById.get(specId)?.slug;
        if (!slug) continue;
        dupClusters.push({ slug, position: list[0].position, ids: list.map((l) => l.id), statuses: list.map((l) => l.status) });
      }
      for (const cluster of dupClusters) {
        try {
          await recordDirectorActivity(admin, {
            workspaceId,
            directorFunction: "platform",
            actionKind: "spec_phases_anomaly",
            specSlug: cluster.slug,
            reason: `reconciler:spec-drift surfaced duplicate spec_phases rows for ${cluster.slug} position ${cluster.position} — ${cluster.ids.length} rows share (spec_id, position). The unique index should prevent this; inspect which carries the truth + dedupe.`,
            metadata: { actor: "reconciler:spec-drift", kind: "duplicate_position", slug: cluster.slug, position: cluster.position, ids: cluster.ids, statuses: cluster.statuses },
          });
          dupReported++;
        } catch { /* best-effort audit */ }
      }
    }
  } catch { /* best-effort — a read failure leaves the next beat to retry */ }

  // PROVENANCE GAP sweep: a shipped spec_phases row with both pr IS NULL and merge_sha IS NULL. The
  // per-phase PR chip can't render and the audit trail loses the shipping commit. Group by spec so the
  // director sees one row per spec, not one per phase.
  try {
    const { data: shippedGaps } = await admin
      .from("spec_phases")
      .select("position, pr, merge_sha, specs!inner(slug, workspace_id, status)")
      .eq("specs.workspace_id", workspaceId)
      .eq("status", "shipped")
      .is("pr", null)
      .is("merge_sha", null);
    type GapRow = {
      position: number;
      pr: number | null;
      merge_sha: string | null;
      specs:
        | { slug: string; workspace_id: string; status: string }
        | { slug: string; workspace_id: string; status: string }[];
    };
    const gapsBySlug = new Map<string, number[]>();
    for (const r of (shippedGaps ?? []) as GapRow[]) {
      const spec = Array.isArray(r.specs) ? r.specs[0] : r.specs;
      if (!spec?.slug || spec.status === "folded") continue;
      const list = gapsBySlug.get(spec.slug) ?? [];
      list.push(r.position);
      gapsBySlug.set(spec.slug, list);
    }
    for (const [slug, positions] of gapsBySlug) {
      const sorted = positions.sort((a, b) => a - b);
      try {
        await recordDirectorActivity(admin, {
          workspaceId,
          directorFunction: "platform",
          actionKind: "spec_phases_anomaly",
          specSlug: slug,
          reason: `reconciler:spec-drift surfaced ${sorted.length} shipped phase(s) of ${slug} (P${sorted.join(", P")}) with no PR + no merge_sha — provenance lost. Backfill from the build job / merge hook so the per-phase PR chip and the audit trail recover.`,
          metadata: { actor: "reconciler:spec-drift", kind: "provenance_gap", slug, phases: sorted },
        });
        gapReported++;
      } catch { /* best-effort audit */ }
    }
  } catch { /* best-effort — a read failure leaves the next beat to retry */ }

  return { orphans: orphanReported, duplicates: dupReported, provenanceGaps: gapReported };
}

/** Upsert an open `spec_drift` row per DB-shipped-but-code-missing phase; resolve rows that recovered. */
async function syncReverseDriftRows(workspaceId: string, suspects: { slug: string; index: number; title: string }[]): Promise<void> {
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const keep = new Set(suspects.map((s) => `${s.slug}#${s.index}`));
  for (const s of suspects) {
    const detail = `${s.slug} — P${s.index + 1} (${s.title}) is marked SHIPPED in the DB, but its code is NOT on main (possible bad/reverted merge or a wrong status write). Confirm + escalate.`;
    const { data: existing } = await admin
      .from("spec_drift").select("id").eq("workspace_id", workspaceId).eq("spec_slug", s.slug).eq("phase_index", s.index).eq("status", "open").limit(1);
    if (existing && existing.length) {
      await admin.from("spec_drift").update({ last_seen_at: nowIso, phase_title: s.title, current_emoji: "✅↛", detail }).eq("id", (existing[0] as { id: string }).id);
    } else {
      await admin.from("spec_drift").insert({ workspace_id: workspaceId, spec_slug: s.slug, phase_index: s.index, phase_title: s.title, current_emoji: "✅↛", detail, status: "open" }).then(undefined, () => {});
    }
  }
  // Resolve any open row that's no longer a suspect (the code came back / the phase was downgraded).
  const { data: open } = await admin.from("spec_drift").select("id, spec_slug, phase_index").eq("workspace_id", workspaceId).eq("status", "open");
  for (const row of (open ?? []) as { id: string; spec_slug: string; phase_index: number }[]) {
    if (!keep.has(`${row.spec_slug}#${row.phase_index}`)) {
      await admin.from("spec_drift").update({ status: "resolved", last_seen_at: nowIso }).eq("id", row.id);
    }
  }
}

/** Open spec-drift rows for a workspace (newest-bumped first) — the Control Tower's "Spec drift" surface. */
export async function getOpenSpecDrift(workspaceId: string): Promise<SpecDriftRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("spec_drift")
    .select("id, spec_slug, phase_index, phase_title, current_emoji, detail, status, opened_at, last_seen_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "open")
    .order("last_seen_at", { ascending: false })
    .limit(100);
  return (data ?? []) as SpecDriftRow[];
}

/**
 * Resolve open drift rows for a (workspace, slug) — called after the owner one-tap flips/dismisses a
 * phase on the Control Tower. Pass `phaseIndex` to resolve only that phase's row (the others stay open);
 * omit it to resolve every open row for the slug.
 */
export async function resolveSpecDrift(workspaceId: string, slug: string, phaseIndex?: number): Promise<void> {
  const admin = createAdminClient();
  let q = admin
    .from("spec_drift")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("status", "open");
  if (phaseIndex !== undefined) q = q.eq("phase_index", phaseIndex);
  await q;
}
