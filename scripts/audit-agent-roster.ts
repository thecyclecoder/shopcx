/**
 * Audit: agent-roster drift (agent-roster-sync spec, Phase 3 — the keep-in-sync drift guard).
 *
 * Reconciles the THREE roster sources and flags any drift among them, so roster ↔ personas ↔
 * live lanes can't silently diverge again (the drift the goal found on 2026-06-24):
 *
 *   1. PERSONAS               — the reskinnable cast (src/lib/agents/personas.ts).
 *   2. MONITORED_LOOPS        — the Control Tower registry (cron `personaKind` + `agentKind` lanes).
 *   3. live `agent_jobs.kind` — lanes with recent rows in the box queue.
 *
 * Three drift categories (deterministic + read-only):
 *   A. persona-without-loop   — a WORKER persona that nothing in the registry runs AND isn't a live
 *                               lane (a dead cast member). A live-but-unregistered one is caught by C.
 *   B. loop-without-persona   — a registry lane (agentKind / personaKind) whose persona key has no
 *                               personas.ts entry (it would render as a neutral 🤖 fallback).
 *   C. live-lane-unregistered — an agent_jobs.kind running with NO MONITORED_LOOPS row (surfaced on
 *                               the org view as a flagged worker, but it should get a registry row).
 *
 * Clean registry ⇒ prints "0 drift". Remove a rostered loop locally and re-run ⇒ it names that exact
 * persona/lane mismatch. READ-ONLY — surfaces drift, never mutates. See docs/brain/dashboard/agents.md.
 *
 * Run: npx tsx scripts/audit-agent-roster.ts
 */
import { createAdminClient } from "./_bootstrap";
import { MONITORED_LOOPS, OWNER_FUNCTIONS } from "../src/lib/control-tower/registry";
import { PERSONAS } from "../src/lib/agents/personas";
import { buildRoster } from "../src/lib/agents/org-chart";

const DAY = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_MS = 7 * DAY; // matches org-chart.ts ROSTER_ACTIVE_WINDOW_MS

interface Drift {
  type: "persona-without-loop" | "loop-without-persona" | "live-lane-unregistered";
  key: string;
  detail: string;
}

async function main() {
  const admin = createAdminClient();
  const directorSlugs = new Set(OWNER_FUNCTIONS.map((f) => f.id as string));

  // Source 3: live agent_jobs kinds (recent rows).
  const liveKinds = new Set<string>();
  const sinceIso = new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();
  const { data: jobRows, error } = await admin.from("agent_jobs").select("kind").gte("created_at", sinceIso).limit(5000);
  if (error) {
    console.error("⚠️  could not read agent_jobs (live-lane drift unchecked):", error.message);
  }
  for (const r of (jobRows ?? []) as { kind: string | null }[]) if (r.kind) liveKinds.add(r.kind);

  // The reconciled roster (the SAME reader the org view uses).
  const roster = buildRoster(directorSlugs, liveKinds);

  console.log("=== Agent roster (reconciled — what /dashboard/agents shows) ===");
  for (const e of roster) {
    console.log(
      `  ${e.owner.padEnd(10)} ${e.kind.padEnd(22)} ${e.cronBacked ? "[cron]" : "[lane]"}${e.flagged ? " ⚠ unregistered" : ""}`,
    );
  }
  console.log(`  (${roster.length} rostered workers across ${directorSlugs.size} directors)\n`);

  // Registry index.
  const agentKinds = new Set(MONITORED_LOOPS.filter((l) => l.agentKind).map((l) => l.agentKind as string));
  const personaKinds = new Set(
    MONITORED_LOOPS.filter((l) => l.personaKind).map((l) => l.personaKind as string),
  );
  const inRegistry = (k: string) => agentKinds.has(k) || personaKinds.has(k);

  // Worker personas = the cast minus the directors + the CEO seat.
  const workerPersonaKeys = Object.keys(PERSONAS).filter((k) => !directorSlugs.has(k) && k !== "ceo");

  const drift: Drift[] = [];

  // A. persona with no registry row AND not a live lane → a dead cast member.
  for (const k of workerPersonaKeys) {
    if (!inRegistry(k) && !liveKinds.has(k)) {
      drift.push({
        type: "persona-without-loop",
        key: k,
        detail: `persona "${PERSONAS[k].name}/${k}" exists but no MONITORED_LOOPS row runs it (and no live agent_jobs lane)`,
      });
    }
  }

  // B. registry lane whose persona key is missing from personas.ts (renders as a 🤖 fallback).
  for (const l of MONITORED_LOOPS) {
    const key = l.personaKind ?? (l.kind === "agent-kind" ? l.agentKind : undefined);
    if (key && !(key in PERSONAS)) {
      drift.push({
        type: "loop-without-persona",
        key,
        detail: `loop "${l.id}" maps to persona "${key}" which has no personas.ts entry (renders as a neutral fallback)`,
      });
    }
  }

  // C. live agent_jobs lane with no registry row (surfaced flagged, but should be registered).
  for (const k of liveKinds) {
    if (!inRegistry(k)) {
      drift.push({
        type: "live-lane-unregistered",
        key: k,
        detail: `agent_jobs lane "${k}" has recent rows but no MONITORED_LOOPS entry — register it (or add a personaKind cron)`,
      });
    }
  }

  console.log("=== Drift ===");
  if (drift.length === 0) {
    console.log("  0 drift — roster ↔ personas ↔ live lanes are in sync ✅");
  } else {
    for (const d of drift) console.log(`  ⚠ [${d.type}] ${d.detail}`);
    console.log(`\n  ${drift.length} drift item(s).`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
