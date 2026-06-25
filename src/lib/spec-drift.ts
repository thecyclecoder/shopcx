/**
 * spec-drift — keep a spec's phase emojis in sync with shipped code (spec-drift-agent spec).
 *
 * Builds keep merging without their phase emoji flipping ⏳/🚧 → ✅, so shipped work parks in the
 * Planned/In-progress columns. This module is the per-phase, EVIDENCE-GATED reconciler that closes
 * that drift. It NEVER guesses "merged ⇒ done": for each phase it weighs two independent signals —
 *
 *   1. a merged `kind='build'` agent_job for the spec (the work was actually shipped), and
 *   2. the phase's claimed code is verifiably on `main` (every file path / migration it names exists).
 *
 * and acts per-phase:
 *   - merged build  AND all named code on main, emoji still ⏳/🚧 → AUTO-FLIP that phase ✅ (commit to main).
 *   - all named code on main but NO merged build on record (can't be confident it was this phase's
 *     deliberate ship) → SURFACE it as drift for a one-tap owner flip (never a wrong auto-flip).
 *   - code not fully on main, or the phase names no verifiable paths → LEAVE it (genuinely unbuilt:
 *     a fan-out phase, a deferred follow-on). This is the guardrail against over-flagging multi-phase
 *     specs with real pending later phases (pdp-refinement-pass P3, winning-static-creative-finder P6).
 *
 * The spec's column then follows from deriveStatus over the corrected phases — a spec is "shipped"
 * only when EVERY phase is ✅ (so pdp-refinement-pass stays in-progress while P3 is real, but its
 * P1/P2 read ✅). This only ever rewrites the leading phase emoji (+ a now-consistent H1 ✅); it
 * never touches spec logic and never marks a spec VERIFIED (that's the owner's gate). It reconciles
 * planned↔shipped phase truth only.
 *
 * Two triggers (same engine): the build-merge path (reconcileMergedJobs, the root fix — Part A) and a
 * Control-Tower self-audit cron backstop (spec-drift-reconcile — Part B). Surfaced drift lands in the
 * `spec_drift` table, rendered on the Control Tower for a one-tap flip. See docs/brain/libraries/spec-drift.md.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { deriveSpecStatus, getRoadmap, listArchivedSlugs, phaseEmoji, type Phase, type SpecStatus } from "@/lib/brain-roadmap";
import { markSpecCardStatus, type SpecCardPhaseState } from "@/lib/spec-card-state";

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

// ── Phase parsing (line-tracked, mirrors brain-roadmap parseSpec ordering) ───────────────────────

const PLANNED = "⏳";
const IN_PROGRESS = "🚧";
const SHIPPED = "✅";
const REJECTED = "❌";
const EMOJI_RE = /[⏳🚧✅❌]/;

function statusFromText(s: string): Phase | null {
  if (s.includes(REJECTED)) return "rejected";
  if (s.includes(IN_PROGRESS)) return "in_progress";
  if (s.includes(PLANNED)) return "planned";
  if (s.includes(SHIPPED)) return "shipped";
  return null;
}

/** One phase with the exact line whose leading emoji encodes its status (for surgical rewrites). */
export interface DriftPhase {
  index: number; // 0-based, matches the board parser order + /api/roadmap/status phaseIndex
  title: string;
  status: Phase;
  emojiLine: number; // line index carrying the status emoji (heading line, or the bullet under it)
  body: string; // the phase's text — what we scan for code paths
}

/**
 * Parse a spec's phases with line numbers, mirroring brain-roadmap parseSpec EXACTLY so a phase's
 * `index` here matches the board + the status route. Heading shape (`## Phase N — … <emoji>`) is
 * primary; the `## Phases` bullet shape (`- ✅ **P1 …**`) is the fallback only when no heading-phases
 * exist. Returns [] for a spec with neither shape.
 */
export function parsePhasesWithLines(raw: string): DriftPhase[] {
  const lines = raw.split("\n");
  const phases: DriftPhase[] = [];

  // Primary: a phase heading at H2 (`## Phase …`) OR H3 (`### Phase …` under a `## Phases` wrapper).
  // Matching only H2 left H3-phase specs with zero phases → stuck at `planned`. `Phase\b` skips
  // `## Phases`. Two invariants now layered on top:
  //   - Boundary rule (skip-verification-subsections, PR #562): the canonical spec shape includes
  //     a `## Verification` section with `### Phase N — …` subheaders mirroring each real phase —
  //     an unguarded H3 match double-counted them, stranding shipped specs with phantom ⏳ phases.
  //     So an H3 phase heading is counted ONLY when its nearest preceding H2 is `## Phases`
  //     (PR #557's wrapper case); under `## Verification`, `## Completion criteria`, `## Safety /
  //     invariants`, `## Background`, an H2 `## Phase N — …`, or any other section, an H3
  //     `### Phase` is skipped. H2 `## Phase N — …` lines remain unconditionally counted.
  //   - Fence rule (skip-fenced-code-blocks): any `##`/`###` Phase line inside a ``` or ~~~ fenced
  //     code block is documentation, not a real phase. A spec embedding a canonical-shape EXAMPLE
  //     in `## Background` / `## Anti-pattern` (e.g. the folded sibling's `## Background` ``` block
  //     with 3 fenced `## Phase N` lines) otherwise inflates its phase count by the example. The
  //     same fence guard applies to `currentH2` updates — a `## Whatever` inside a fence is NOT a
  //     real section boundary — and to the fallback `## Phases` bullet path below.
  const isPhaseLine = (l: string) => /^#{2,3}\s+Phase\b/.test(l);
  const inPhasesWrapper = (currentH2: string | null) => /^Phases$/i.test(currentH2 ?? "");
  const isPhaseHeading = (l: string, currentH2: string | null): boolean => {
    if (!isPhaseLine(l)) return false;
    if (l.startsWith("## ")) return true; // H2 — always a real phase heading
    return inPhasesWrapper(currentH2); // H3 — only inside the `## Phases` wrapper
  };

  // Precompute fence state per line. A fence delimiter (```` ``` ```` or `~~~`) toggles `inFence`;
  // delimiter lines themselves are marked as in-fence so they're also skipped (harmless, since they
  // don't match any phase/section pattern anyway). Lines marked in-fence are skipped wholesale by
  // both the primary loop (no phase detection, no currentH2 update, no body-end termination) and
  // the fallback loop (no `## Phases` wrapper entry, no bullet detection).
  const fenceRe = /^\s*(```|~~~)/;
  const inFence: boolean[] = new Array(lines.length).fill(false);
  {
    let f = false;
    for (let i = 0; i < lines.length; i++) {
      if (fenceRe.test(lines[i])) {
        f = !f;
        inFence[i] = true;
        continue;
      }
      inFence[i] = f;
    }
  }

  let currentH2: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^##\s+/.test(lines[i])) {
      currentH2 = lines[i].replace(/^##\s+/, "").trim();
    }
    if (!isPhaseHeading(lines[i], currentH2)) continue;
    let emojiLine = i;
    let st = statusFromText(lines[i]);
    if (!st) {
      for (let j = i + 1; j < lines.length; j++) {
        if (inFence[j]) continue;
        if (lines[j].startsWith("## ") || isPhaseHeading(lines[j], currentH2)) break;
        const s = statusFromText(lines[j]);
        if (s) {
          st = s;
          emojiLine = j;
          break;
        }
      }
    }
    // Body = heading line → the next phase heading (H2/H3) or the next top-level "## " section.
    // Lines inside a fence are NEVER a body boundary — a fenced `## Phase N` example must not cut
    // the real phase's body short.
    let end = i + 1;
    while (end < lines.length && (inFence[end] || (!lines[end].startsWith("## ") && !isPhaseHeading(lines[end], currentH2)))) end++;
    phases.push({
      index: phases.length,
      title: cleanTitle(lines[i].replace(/^#{2,3}\s+/, "")),
      status: st ?? "planned",
      emojiLine,
      body: lines.slice(i, end).join("\n"),
    });
  }
  if (phases.length) return phases;

  // Fallback: emoji-bearing bullets under a single "## Phases" section.
  let inPhases = false;
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^##\s+Phases?\s*$/i.test(lines[i])) {
      inPhases = true;
      continue;
    }
    if (inPhases && lines[i].startsWith("## ")) break;
    if (!inPhases) continue;
    const bm = lines[i].match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!bm) continue;
    // Recognize a phase bullet by a leading emoji (legacy) OR a `**P1**`/`**Phase 1**` label — Phase 3
    // stripped the emojis, so an emoji-less `- **P1 — …**` must still parse (status defaults `planned`).
    const inner = bm[1].replace(/^[⏳🚧✅❌]\s*/, "");
    if (!statusFromText(lines[i]) && !/^\*{0,2}(P\d+|Phase\s+\d+)\b/i.test(inner)) continue;
    // Body = this bullet + its indented continuation (sub-bullets) until the next top-level bullet / section.
    // Lines inside a fence don't terminate the body.
    let end = i + 1;
    while (end < lines.length && (inFence[end] || (!/^[-*]\s/.test(lines[end]) && !/^##\s/.test(lines[end])))) end++;
    phases.push({
      index: phases.length,
      title: cleanTitle(bm[1]),
      status: statusFromText(lines[i]) ?? "planned",
      emojiLine: i,
      body: lines.slice(i, end).join("\n"),
    });
  }
  return phases;
}

/** A spec's phases as the board mirror stores them — `[{ index, title, status }]` (spec-card-db-companion). */
export function phaseStatesFromRaw(raw: string): SpecCardPhaseState[] {
  return parsePhasesWithLines(raw).map((p) => ({ index: p.index, title: p.title, status: p.status }));
}

function cleanTitle(s: string): string {
  return s
    .replace(EMOJI_RE, "")
    .replace(/\*\*/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, alias) => alias || link)
    .replace(/\s+/g, " ")
    .trim();
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

// ── Phase-emoji writeback (surgical — leading emoji only) ──────────────────────────────────────────

/** Replace the first status emoji on a line with `target`, preserving position; insert one if absent. */
function setEmojiOnLine(line: string, target: string): string {
  if (EMOJI_RE.test(line)) return line.replace(EMOJI_RE, target);
  const heading = line.match(/^(#{1,6}\s+)(.*)$/);
  if (heading) return `${heading[1]}${heading[2].replace(/\s+$/, "")} ${target}`;
  const bullet = line.match(/^(\s*[-*]\s+)(.*)$/);
  if (bullet) return `${bullet[1]}${target} ${bullet[2]}`;
  return `${line} ${target}`;
}

/** Set the H1 title's status emoji (strip any existing ⏳/🚧/✅, append target). Leaves an explicit ❌ alone. */
function setH1(raw: string, target: string): string {
  const lines = raw.split("\n");
  const i = lines.findIndex((l) => l.startsWith("# "));
  if (i < 0) return raw;
  if (lines[i].includes(REJECTED)) return raw; // never overwrite an explicit cut title
  lines[i] = `${lines[i].replace(/[⏳🚧✅]/g, "").replace(/\s+$/, "")} ${target}`;
  return lines.join("\n");
}

/**
 * Flip the phase at `phaseIndex` to ✅ in the spec markdown (leading emoji only), and — if every phase
 * is now ✅ — flip the H1 to ✅ too so the raw markdown agrees with the board's all-✅-is-shipped parse.
 * Pure: returns the new markdown (unchanged if the index is out of range or already ✅). Shared by the
 * reconciler's auto-flip and the one-tap owner flip endpoint, so both shapes flip identically.
 */
export function flipPhaseToShipped(raw: string, phaseIndex: number): string {
  const phases = parsePhasesWithLines(raw);
  const phase = phases.find((p) => p.index === phaseIndex);
  if (!phase || phase.status === "shipped") return raw;
  const lines = raw.split("\n");
  lines[phase.emojiLine] = setEmojiOnLine(lines[phase.emojiLine], SHIPPED);
  let updated = lines.join("\n");
  if (deriveSpecStatus(updated) === "shipped") updated = setH1(updated, SHIPPED);
  return updated;
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
  flipped: { index: number; title: string }[]; // phases auto-flipped ✅ this run
  surfaced: { index: number; title: string }[]; // phases left for a one-tap owner flip (open drift rows)
  status: SpecStatus; // derived spec status after any flips (incl. `deferred`)
  // The post-reconcile per-phase snapshot (the same one mirrored to the board). The merge-write rolls these
  // up to the card status (chain-and-cardstate-under-automerge Bug A) — empty for a spec with no phases.
  phaseStates: SpecCardPhaseState[];
  reason?: string; // why nothing happened (no token / not on main / no phases)
}

interface ReconcileOpts {
  /** Pre-fetched set of spec slugs with a merged `kind='build'` job (the cron passes this once). */
  mergedBuildSlugs?: Set<string>;
  /** Pre-fetched spec markdown from `main` (skip the GET). */
  rawFromMain?: string;
}

export async function fetchSpecRawFromMain(slug: string): Promise<{ raw: string; sha: string } | null> {
  try {
    const res = await gh("GET", `/repos/${REPO}/contents/docs/brain/specs/${slug}.md?ref=main`);
    if (!res.ok) return null;
    const raw = Buffer.from(String(res.json.content || "").replace(/\s/g, ""), "base64").toString("utf8");
    return { raw, sha: String(res.json.sha || "") };
  } catch {
    return null;
  }
}

/**
 * fix-ship-retests-origin: parse a fix spec's machine-readable `Fixes:` metadata line, stamped by the
 * propose-fix flow (POST /api/roadmap/chat {action:"propose_fix"}). The line links a fix spec back to the
 * ORIGIN spec it resolves + the spec-test `check_key`(s) it targets, e.g.
 *
 *   **Fixes:** comp-subscriptions (check 3f9a1c2b7e0d5a64, 9b2e…)
 *
 * Strict by design: requires the `(check …)` parenthetical so a stray "Fixes:" in prose can't false-positive
 * into an unwanted origin re-test (the "deduped + bounded, back-compatible" guardrail). First match wins;
 * returns null when there's no link. `checkKeys` are the 16-hex [[checkKey]] hashes (traceability — the
 * re-test re-runs the whole origin spec-test, so the enqueue itself only needs `origin`).
 */
export function parseFixesLink(raw: string): { origin: string; checkKeys: string[] } | null {
  const m = raw.match(/^[ \t>*-]*(?:\*\*)?Fixes:?(?:\*\*)?[ \t]+([a-z0-9][a-z0-9-]*)[ \t]*\(\s*checks?\b([^)]*)\)/im);
  if (!m) return null;
  const origin = m[1];
  const checkKeys = (m[2] || "")
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{16}$/.test(s));
  return { origin, checkKeys };
}

/** Has a build PR for this spec actually merged? (the strong "work shipped" evidence). */
async function hasMergedBuild(workspaceId: string, slug: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("kind", "build")
    .eq("status", "merged")
    .limit(1);
  return !!(data && data.length);
}

/**
 * Reconcile ONE spec's phase emojis against code-on-main + merged-build evidence (the engine both
 * triggers share). Auto-flips confident phases (commits to `main`), upserts/clears `spec_drift` rows
 * for the ambiguous ones, and returns what it did. Never throws — best-effort, returns a reason on skip.
 */
export async function reconcileSpecDrift(workspaceId: string, slug: string, opts: ReconcileOpts = {}): Promise<ReconcileResult> {
  const empty = (reason: string): ReconcileResult => ({ slug, flipped: [], surfaced: [], status: "planned", phaseStates: [], reason });
  if (!/^[a-z0-9-]+$/i.test(slug)) return empty("invalid slug");
  if (!ghToken()) return empty("no GitHub token");

  const fetched = opts.rawFromMain ? { raw: opts.rawFromMain, sha: "" } : await fetchSpecRawFromMain(slug);
  if (!fetched) return empty("spec not on main");
  let { raw } = fetched;
  let { sha } = fetched;

  const phases = parsePhasesWithLines(raw);
  if (!phases.length) return { slug, flipped: [], surfaced: [], status: deriveSpecStatus(raw), phaseStates: [], reason: "no phases" };

  const mergedBuild =
    opts.mergedBuildSlugs !== undefined ? opts.mergedBuildSlugs.has(slug) : await hasMergedBuild(workspaceId, slug);

  const cache = new Map<string, boolean>();
  const flipped: { index: number; title: string }[] = [];
  const surfaced: { index: number; phase: DriftPhase }[] = [];

  // Decide per stale phase (anything not already ✅ and not an explicit ❌ cut).
  for (const phase of phases) {
    if (phase.status === "shipped" || phase.status === "rejected") continue;
    const paths = extractCodePaths(phase.body);
    if (paths.length === 0) continue; // nothing to verify → can't be confident → leave (genuinely unbuilt)
    const checks = await Promise.all(paths.map((p) => pathExistsOnMain(p, cache)));
    const allOnMain = checks.every(Boolean);
    if (!allOnMain) continue; // code not (fully) on main → genuinely unbuilt / fan-out / mid-build → leave

    if (mergedBuild) {
      flipped.push({ index: phase.index, title: phase.title }); // confident: flip ✅
    } else {
      surfaced.push({ index: phase.index, phase }); // code on main but no merged build on record → surface
    }
  }

  // spec-status-db-driven Phase 2: the auto-flip used to PUT the spec markdown to `main` (one of the six
  // git-committing status writers). Now it updates the in-memory `raw` so the rollup downstream still
  // reads the new ✅ for derivation, but skips the deploy-triggering commit — the DB mirror write below
  // is the SOLE persistence path.
  if (flipped.length) {
    for (const f of flipped) raw = flipPhaseToShipped(raw, f.index);
  }
  // suppress unused-warning for `sha` (the markdown PUT was the only caller).
  void sha;

  await syncDriftRows(workspaceId, slug, surfaced);

  // Write the post-reconcile status + per-phase snapshot to the board mirror. spec-status-db-driven Phase 2:
  // zero markdown commits, zero deploys for status; the audit row records the auto-flip.
  let phaseStates = phaseStatesFromRaw(raw);
  // spec-status-db-driven Phase 4: the markdown no longer carries status emojis (Phase 3 stripped them), so a
  // phase with no extractable code paths reads `planned` here even after it shipped. FORWARD-MERGE with the
  // DB's current per-phase status so reconcile can only ever ADVANCE a phase, never regress a shipped one.
  try {
    const { getSpecCardStates, mergePhaseStates } = await import("@/lib/spec-card-state");
    const states = await getSpecCardStates(workspaceId);
    phaseStates = mergePhaseStates(phaseStates, states[slug]);
  } catch {
    /* DB read failed → fall back to the markdown-derived phaseStates (no regression protection this pass) */
  }
  const { rollupPhaseStatus } = await import("@/lib/spec-card-state");
  const status: SpecStatus = phaseStates.length ? rollupPhaseStatus(phaseStates) : deriveSpecStatus(raw);
  const reason = flipped.length
    ? `auto-flip ${flipped.map((f) => `P${f.index + 1}`).join(", ")} → ✅ (code on main + build merged)`
    : "drift reconcile (no flip)";
  await markSpecCardStatus(workspaceId, slug, status, phaseStates, { actor: "drift:reconciler", reason });

  return { slug, flipped, surfaced: surfaced.map((s) => ({ index: s.phase.index, title: s.phase.title })), status, phaseStates };
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

/**
 * Reese, repurposed (spec-status-db-driven Phase 4): the DB-vs-CODE consistency backstop. Status is now
 * DB-driven, so the old "markdown emoji vs code" reconciler is gone. Reese's new job is the INVERSE + the
 * one that actually matters in the DB world: for every phase `spec_card_state` marks **shipped**, verify the
 * phase's code is ACTUALLY on `main`. If a shipped phase's code paths are missing (a bad/reverted merge, a
 * wrong DB write), surface a `spec_drift` row — "DB says shipped, code is gone" — for Ada's supervision lane
 * to confirm + escalate. NEVER mutates status here (surface-don't-auto-correct, North star). The phase code
 * paths still live in the markdown body (content stayed in markdown); only STATUS moved to the DB.
 */
export async function runSpecDriftReconciler(workspaceId: string): Promise<DriftSweepResult> {
  if (!ghToken()) return { specsScanned: 0, flipped: 0, surfaced: 0 };
  const { getSpecCardStates } = await import("@/lib/spec-card-state");
  const archived = new Set(await listArchivedSlugs());
  const states = await getSpecCardStates(workspaceId);
  const cache = new Map<string, boolean>();
  const suspects: { slug: string; index: number; title: string }[] = [];
  let scanned = 0;

  for (const [slug, state] of Object.entries(states)) {
    if (archived.has(slug)) continue;
    const shipped = (state.phase_states ?? []).filter((p) => p.status === "shipped");
    if (!shipped.length) continue;
    const fetched = await fetchSpecRawFromMain(slug);
    if (!fetched) continue; // spec folded / not on main → nothing to verify against
    scanned++;
    const phases = parsePhasesWithLines(fetched.raw);
    for (const sp of shipped) {
      const phase = phases.find((p) => p.index === sp.index);
      if (!phase) continue;
      const paths = extractCodePaths(phase.body);
      if (!paths.length) continue; // no code paths declared → can't verify → trust the DB (don't false-flag)
      const checks = await Promise.all(paths.map((p) => pathExistsOnMain(p, cache)));
      if (!checks.every(Boolean)) suspects.push({ slug, index: sp.index, title: sp.title }); // shipped in DB, code missing on main
    }
  }
  // ada-director-spec-status-cards Phase 3: any suspect whose most recent status flip was a director
  // auto-apply (`actor=director:*`) is REVERTED — the leash's reversibility backstop. Build-merge-applied
  // shipped phases that lost their code go through the surface path (the existing behavior); the operator
  // confirms. Reverting a director flip writes one correction row to `spec_status_history` (actor=drift-
  // reconciler) and one `director_activity` row (`reverted_director_flip`) so a recurring mis-flip pattern
  // surfaces on the daily watch.
  const reverted = await revertDirectorFlippedSuspects(workspaceId, states, suspects);
  // Suspects we reverted no longer need surfacing — they're DB-corrected; only the rest get a drift row.
  const surfaceList = suspects.filter((s) => !reverted.has(`${s.slug}#${s.index}`));
  await syncReverseDriftRows(workspaceId, surfaceList);
  return { specsScanned: scanned, flipped: 0, surfaced: surfaceList.length };
}

/**
 * Per suspect, look up the most recent `spec_status_history` `field='status'` row whose `actor` is
 * `director:*` — that's the flip we're catching. If one is found, revert the spec_card_state row's
 * status to its `from_value` and stamp a correction history row (actor=`drift-reconciler`, reason
 * names the original director). Returns the set of `slug#index` keys that were reverted so the caller
 * can skip surfacing them as drift. Best-effort throughout — a DB read/write failure on one suspect
 * never blocks the next; the sweep runs again next beat.
 */
async function revertDirectorFlippedSuspects(
  workspaceId: string,
  states: Record<string, import("@/lib/spec-card-state").SpecCardState>,
  suspects: { slug: string; index: number; title: string }[],
): Promise<Set<string>> {
  const reverted = new Set<string>();
  if (!suspects.length) return reverted;
  const admin = createAdminClient();
  const { markSpecCardStatus } = await import("@/lib/spec-card-state");
  // De-dup by slug — one revert per spec is enough; the rollup recomputes from all phases.
  const slugs = Array.from(new Set(suspects.map((s) => s.slug)));
  for (const slug of slugs) {
    const decision = await decideDirectorRevert(admin, workspaceId, slug);
    if (!decision) continue;
    const state = states[slug];
    if (!state) continue;
    const phaseStates = (state.phase_states ?? []).map((p) => ({ ...p }));
    try {
      await markSpecCardStatus(workspaceId, slug, decision.revertTo, phaseStates, {
        actor: "drift-reconciler",
        reason: `${decision.directorActor} flip not backed by merged code`,
      });
    } catch {
      continue; // a write failure leaves the suspect on the surface path next beat
    }
    try {
      const { recordDirectorActivity } = await import("@/lib/director-activity");
      const directorFunction = decision.directorActor.replace(/^director:/, "") || "platform";
      await recordDirectorActivity(admin, {
        workspaceId,
        directorFunction,
        actionKind: "reverted_director_flip",
        specSlug: slug,
        reason: `drift-reconciler reverted ${decision.directorActor} status flip — phase code missing on main`,
        metadata: { from: "shipped", revert_to: decision.revertTo, director_actor: decision.directorActor },
      });
    } catch { /* audit is best-effort */ }
    for (const s of suspects) if (s.slug === slug) reverted.add(`${s.slug}#${s.index}`);
  }
  return reverted;
}

/**
 * Pure-ish helper: read the most recent `field='status'` history rows for one slug and decide whether to
 * revert. Returns `{ revertTo, directorActor }` when the most recent status flip was a director auto-apply
 * AND has a parseable `from_value`; null otherwise (build-merge flip · owner flip · no history · stale).
 * Exported so the test suite can exercise the decision against a synthetic row set without hitting Supabase.
 */
export async function decideDirectorRevert(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  slug: string,
): Promise<{ revertTo: SpecStatus; directorActor: string } | null> {
  const { data } = await admin
    .from("spec_status_history")
    .select("actor, from_value, to_value")
    .eq("workspace_id", workspaceId)
    .eq("spec_slug", slug)
    .eq("field", "status")
    .order("at", { ascending: false })
    .limit(1);
  const rows = (data ?? []) as { actor: string; from_value: string | null; to_value: string }[];
  return decideDirectorRevertFromRows(rows);
}

/** Pure logic: given the most-recent-first status history rows for one slug, decide a revert. */
export function decideDirectorRevertFromRows(
  rows: { actor: string; from_value: string | null; to_value: string }[],
): { revertTo: SpecStatus; directorActor: string } | null {
  if (!rows.length) return null;
  const most = rows[0];
  if (!most.actor.startsWith("director:")) return null;
  // The director flip we want to revert must have moved status TO shipped (a director-stamped row that's
  // already non-shipped is either already corrected or wasn't the cause of the missing-code drift).
  const parsedTo = safeParseStatus(most.to_value);
  if (parsedTo !== "shipped") return null;
  const revertTo = safeParseStatus(most.from_value) ?? "in_progress";
  return { revertTo, directorActor: most.actor };
}

function safeParseStatus(json: string | null): SpecStatus | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (v === "planned" || v === "in_progress" || v === "shipped" || v === "rejected" || v === "deferred") return v;
    return null;
  } catch {
    return null;
  }
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
