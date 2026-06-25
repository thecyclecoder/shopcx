// backfill-phase-pr-provenance — spec-status-phase-pr-provenance Phase 2 one-time backfill.
//
// For every LIVE spec in docs/brain/specs/ with merged `kind='build'` agent_jobs, attribute each
// merged build to the phase(s) it shipped and write `spec_card_state.phase_states[idx] = {
// status:'shipped', pr, merge_sha }` so existing shipped work carries the same provable provenance
// that Phase 1's merge-hook stamps onto new builds.
//
//   Dry run (default):  npx tsx scripts/backfill-phase-pr-provenance.ts
//   Apply:              npx tsx scripts/backfill-phase-pr-provenance.ts --apply
//
// Mapping rules:
//   - parse "Phase N" from build.instructions → those phase indices (0-based)
//   - else (no parseable scope) for a MULTI-phase spec, assign sequentially in merge order
//     (1st merge → P1, 2nd → P2 …) until phases run out (further unattributed merges are dropped)
//   - SINGLE-phase spec → P0 always
//   - ONE-shot spec (0 phases) → card-level via flags.merged_pr + last_merge_sha (latest merge wins)
//
// Dedupe: the LATEST PR per phase wins (most recent merge — the truthful shipping PR for that phase).
// Phases with NO attributed merge stay `planned` (genuinely unbuilt). Records one history row per
// changed phase (actor='backfill'). Idempotent: re-running on stable state is a no-op.
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");
const SPECS_DIR = resolve(__dirname, "../docs/brain/specs");
const REPO = process.env.AGENT_TODO_REPO || "thecyclecoder/shopcx";
const TOKEN = process.env.GITHUB_TOKEN || process.env.AGENT_TODO_GITHUB_TOKEN;

type Phase = "planned" | "in_progress" | "shipped" | "rejected";

interface PhaseState {
  index: number;
  title: string;
  status: Phase;
  pr?: number | null;
  merge_sha?: string | null;
}

interface BuildJob {
  id: string;
  spec_slug: string;
  workspace_id: string;
  pr_number: number | null;
  instructions: string | null;
  created_at: string;
}

function statusFromText(s: string): Phase | null {
  if (s.includes("❌")) return "rejected";
  if (s.includes("🚧")) return "in_progress";
  if (s.includes("⏳")) return "planned";
  if (s.includes("✅")) return "shipped";
  return null;
}

function cleanTitle(s: string): string {
  return s
    .replace(/[⏳🚧✅❌]/g, "")
    .replace(/\*\*/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, alias) => alias || link)
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse spec markdown for its phase list — same shape brain-roadmap / spec-drift produce. */
function parsePhases(raw: string): { index: number; title: string; status: Phase }[] {
  const lines = raw.split("\n");
  const phases: { title: string; status: Phase }[] = [];

  let currentH2: string | null = null;
  const isPhaseLine = (l: string) => /^#{2,3}\s+Phase\b/.test(l);
  const inPhasesWrapper = (h2: string | null) => /^Phases$/i.test(h2 ?? "");
  const isPhaseHeading = (l: string, h2: string | null): boolean => {
    if (!isPhaseLine(l)) return false;
    if (l.startsWith("## ")) return true;
    return inPhasesWrapper(h2);
  };

  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) currentH2 = lines[i].replace(/^##\s+/, "").trim();
    if (!isPhaseHeading(lines[i], currentH2)) continue;
    let st = statusFromText(lines[i]);
    if (!st) {
      for (let j = i + 1; j < lines.length && !lines[j].startsWith("## ") && !isPhaseHeading(lines[j], currentH2); j++) {
        const s = statusFromText(lines[j]);
        if (s) { st = s; break; }
      }
    }
    phases.push({ title: cleanTitle(lines[i].replace(/^#{2,3}\s+/, "")), status: st ?? "planned" });
  }

  if (!phases.length) {
    let inPhases = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Phases?\s*$/i.test(lines[i])) { inPhases = true; continue; }
      if (inPhases && lines[i].startsWith("## ")) break;
      if (!inPhases) continue;
      const bm = lines[i].match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (!bm) continue;
      const inner = bm[1].replace(/^[⏳🚧✅❌]\s*/, "");
      if (!statusFromText(lines[i]) && !/^\*{0,2}(P\d+|Phase\s+\d+)\b/i.test(inner)) continue;
      phases.push({ title: cleanTitle(bm[1]), status: statusFromText(lines[i]) ?? "planned" });
    }
  }
  return phases.map((p, i) => ({ index: i, title: p.title, status: p.status }));
}

/** Parse "Phase N" / "Phase N" mentions in build instructions → 0-based indices clamped to [0, count). */
function parsePhaseIndices(instructions: string | null | undefined, count: number): number[] {
  if (!instructions) return [];
  const idxs = new Set<number>();
  for (const m of instructions.matchAll(/\bPhase\s+(\d+)\b/gi)) {
    const i = parseInt(m[1], 10) - 1;
    if (i >= 0 && i < count) idxs.add(i);
  }
  return [...idxs];
}

/** Fetch a merged PR's `merge_commit_sha` from GitHub. Returns null on miss / no token. */
async function fetchMergeSha(pr: number): Promise<string | null> {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${pr}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { merge_commit_sha?: string; merged?: boolean };
    if (!json.merged) return null;
    return json.merge_commit_sha ?? null;
  } catch {
    return null;
  }
}

/** Per-spec attribution of merged builds → shipped phase indices, latest-PR-wins per phase. */
interface Attribution {
  phaseTags: Map<number, { pr: number; merge_sha: string | null }>;
  // For one-shot specs (no phases) — the latest shipped PR's metadata; null if no merged build.
  cardLevel: { pr: number; merge_sha: string | null } | null;
  totalBuilds: number;
  attributed: number;
}

async function attributeBuilds(
  builds: BuildJob[],
  totalPhases: number,
  shaCache: Map<number, string | null>,
): Promise<Attribution> {
  // sort oldest → newest so the sequential assignment is in MERGE order
  const sorted = [...builds].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  const phaseTags = new Map<number, { pr: number; merge_sha: string | null }>();
  let cardLevel: { pr: number; merge_sha: string | null } | null = null;
  let attributed = 0;
  let sequentialCursor = 0;

  for (const b of sorted) {
    if (!b.pr_number) continue;
    if (!shaCache.has(b.pr_number)) shaCache.set(b.pr_number, await fetchMergeSha(b.pr_number));
    const sha = shaCache.get(b.pr_number) ?? null;
    const tag = { pr: b.pr_number, merge_sha: sha };

    if (totalPhases === 0) {
      cardLevel = tag; // latest merge (sorted oldest→newest, so the last assignment wins)
      attributed++;
      continue;
    }
    if (totalPhases === 1) {
      phaseTags.set(0, tag); // single-phase spec: every merge → P0 (latest wins)
      attributed++;
      continue;
    }
    const named = parsePhaseIndices(b.instructions, totalPhases);
    if (named.length) {
      for (const i of named) phaseTags.set(i, tag); // latest scope-naming PR per phase wins
      attributed++;
      continue;
    }
    // Sequential fallback — assign in merge order until phases run out.
    if (sequentialCursor < totalPhases) {
      phaseTags.set(sequentialCursor, tag);
      sequentialCursor++;
      attributed++;
    }
  }
  return { phaseTags, cardLevel, totalBuilds: builds.length, attributed };
}

interface ExistingRow {
  status?: Phase;
  flags?: { [k: string]: boolean | string | number | undefined };
  phase_states?: PhaseState[];
  last_merge_sha?: string | null;
}

function rollupStatus(phases: PhaseState[]): Phase {
  const relevant = phases.filter((p) => p.status !== "rejected");
  if (!relevant.length) return "planned";
  if (relevant.every((p) => p.status === "shipped")) return "shipped";
  if (relevant.some((p) => p.status === "shipped" || p.status === "in_progress")) return "in_progress";
  return "planned";
}

async function main() {
  if (!TOKEN) {
    console.warn("⚠️  No GITHUB_TOKEN / AGENT_TODO_GITHUB_TOKEN — merge SHAs will be null (PR # still recorded).");
  }
  const files = readdirSync(SPECS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  const liveSpecs = new Map<string, { slug: string; phases: { index: number; title: string; status: Phase }[] }>();
  for (const f of files) {
    const slug = f.replace(/\.md$/, "");
    const raw = readFileSync(resolve(SPECS_DIR, f), "utf8");
    liveSpecs.set(slug, { slug, phases: parsePhases(raw) });
  }
  console.log(`Parsed ${liveSpecs.size} live specs from ${SPECS_DIR}`);

  const admin = createAdminClient();
  const { data: workspaces, error: wsErr } = await admin.from("workspaces").select("id, name");
  if (wsErr) throw wsErr;

  const shaCache = new Map<number, string | null>(); // PR # → merge SHA (per-run, cross-workspace safe)
  let totalChanged = 0;

  for (const ws of (workspaces ?? []) as { id: string; name: string | null }[]) {
    console.log(`\n--- workspace ${ws.id} (${ws.name ?? ""}) ---`);

    // Pull every merged build for this workspace once.
    const { data: jobs, error: jobsErr } = await admin
      .from("agent_jobs")
      .select("id, spec_slug, workspace_id, pr_number, instructions, created_at")
      .eq("workspace_id", ws.id)
      .eq("kind", "build")
      .eq("status", "merged");
    if (jobsErr) throw jobsErr;
    const buildsBySlug = new Map<string, BuildJob[]>();
    for (const j of (jobs ?? []) as BuildJob[]) {
      if (!liveSpecs.has(j.spec_slug)) continue; // archived / unknown slug — skip
      const list = buildsBySlug.get(j.spec_slug) ?? [];
      list.push(j);
      buildsBySlug.set(j.spec_slug, list);
    }
    console.log(`  ${buildsBySlug.size} live spec(s) have merged builds`);

    for (const [slug, builds] of buildsBySlug) {
      const spec = liveSpecs.get(slug)!;
      const attribution = await attributeBuilds(builds, spec.phases.length, shaCache);

      const { data: existingData } = await admin
        .from("spec_card_state")
        .select("status, flags, phase_states, last_merge_sha")
        .eq("workspace_id", ws.id)
        .eq("spec_slug", slug)
        .maybeSingle();
      const existing = (existingData ?? {}) as ExistingRow;

      // Start from the markdown phase shape, overlay current DB phase_states (preserve any flips
      // already in the DB), then stamp our attribution's tags. Never regress a shipped phase.
      const RANK: Record<Phase, number> = { rejected: -1, planned: 0, in_progress: 1, shipped: 2 };
      const dbByIndex = new Map((existing.phase_states ?? []).map((p) => [p.index, p]));
      const newPhases: PhaseState[] = spec.phases.map((p) => {
        const db = dbByIndex.get(p.index);
        const base: PhaseState = db
          ? { index: p.index, title: p.title, status: db.status, pr: db.pr ?? null, merge_sha: db.merge_sha ?? null }
          : { index: p.index, title: p.title, status: p.status };
        const tag = attribution.phaseTags.get(p.index);
        if (tag) {
          base.status = RANK[base.status] >= RANK["shipped"] ? base.status : "shipped";
          base.pr = tag.pr;
          base.merge_sha = tag.merge_sha;
        }
        return base;
      });

      const newFlags = { ...(existing.flags ?? {}) };
      let newLastSha = existing.last_merge_sha ?? null;
      if (spec.phases.length === 0 && attribution.cardLevel) {
        newFlags.merged_pr = attribution.cardLevel.pr;
        if (attribution.cardLevel.merge_sha) newLastSha = attribution.cardLevel.merge_sha;
      }

      const newStatus = newPhases.length ? rollupStatus(newPhases) : (existing.status ?? "planned");

      const changedPhases = newPhases.filter((p) => {
        const before = dbByIndex.get(p.index);
        return (
          !before ||
          before.status !== p.status ||
          (before.pr ?? null) !== (p.pr ?? null) ||
          (before.merge_sha ?? null) !== (p.merge_sha ?? null)
        );
      });
      const cardChanged =
        spec.phases.length === 0 &&
        attribution.cardLevel &&
        (existing.flags?.merged_pr !== attribution.cardLevel.pr || existing.last_merge_sha !== newLastSha);
      const statusChanged = existing.status !== newStatus;
      if (!changedPhases.length && !cardChanged && !statusChanged) continue;

      const tagged = newPhases.filter((p) => p.pr).length;
      console.log(
        `  ${slug}: phases=${spec.phases.length} merged=${attribution.totalBuilds} attributed=${attribution.attributed}` +
          ` → status=${newStatus} tagged=${tagged}${cardChanged ? ` cardPR=${attribution.cardLevel!.pr}` : ""}` +
          (statusChanged ? ` (was ${existing.status ?? "—"})` : ""),
      );

      if (!APPLY) continue;

      await admin
        .from("spec_card_state")
        .upsert(
          {
            workspace_id: ws.id,
            spec_slug: slug,
            status: newStatus,
            phase_states: newPhases,
            flags: newFlags,
            last_merge_sha: newLastSha,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "workspace_id,spec_slug" },
        );

      // Audit: one row per actually-changed phase (history table is best-effort).
      const historyRows = changedPhases.map((p) => ({
        workspace_id: ws.id,
        spec_slug: slug,
        field: "phase" as const,
        phase_index: p.index,
        from_value: JSON.stringify(dbByIndex.get(p.index)?.status ?? null),
        to_value: JSON.stringify(p.status),
        actor: "backfill",
        reason: `phase-pr-provenance backfill — tag P${p.index + 1} with PR #${p.pr ?? "?"}`,
      }));
      if (historyRows.length) {
        await admin.from("spec_status_history").insert(historyRows).then(undefined, () => {});
      }
      totalChanged++;
    }
  }

  console.log(`\n${APPLY ? `✓ backfill applied — ${totalChanged} card(s) updated` : `(dry run — ${totalChanged} card(s) would change; pass --apply to write)`}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
