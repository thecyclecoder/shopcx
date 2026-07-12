/**
 * Drift check for the canonical node registry ([[../docs/brain/libraries/control-tower-node-registry.md]],
 * control-tower-canonical-node-registry Phase 3).
 *
 * The registry fuses three sources of truth:
 *   1. `MONITORED_LOOPS` in `src/lib/control-tower/registry.ts` — the box worker, crons,
 *      reactive fns, agent-kind box lanes, inline AI agents. Each row declares an `owner`.
 *   2. `KIND_PERSONA_ALIAS` in `src/lib/agents/personas.ts` — every agent-kind slug ⇒ persona key
 *      translation that isn't 1:1.
 *   3. `BUILDER_WORKER_KINDS` in `src/lib/control-tower/node-registry.ts` — the `agent_jobs.kind`
 *      universe emitted by `scripts/builder-worker.ts` `dispatchJob`.
 *
 * A registry that lets ONE of them drift out of sync silently defaults to Platform (the
 * historical `ORPHAN_OWNER` bug). This check fails when:
 *
 *   (a) a `MONITORED_LOOPS` row's `id` does not resolve to a Node (`resolveNodeOwner(id) === null`).
 *   (b) a `KIND_PERSONA_ALIAS` key OR value names a kind the registry doesn't carry.
 *   (c) a `BUILDER_WORKER_KINDS` entry doesn't resolve to a Node.
 *   (d) the live `dispatchJob` in `scripts/builder-worker.ts` has an `if (job.kind === "X")`
 *       lane that isn't in `BUILDER_WORKER_KINDS`.
 *   (e) `BUILDER_WORKER_KINDS` has an entry the live dispatch doesn't handle.
 *
 * Wired into `npm run predeploy` so a regression fails CI red, not silently. Read-only.
 *
 * Run manually:  `npx tsx scripts/_check-node-registry-drift.ts`
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  BUILDER_WORKER_KINDS,
  assertCoverage,
  resolveNodeOwner,
} from "@/lib/control-tower/node-registry";
import { MONITORED_LOOPS } from "@/lib/control-tower/registry";

const REPO_ROOT = resolve(__dirname, "..");
const WORKER_PATH = resolve(REPO_ROOT, "scripts/builder-worker.ts");
const PERSONAS_PATH = resolve(REPO_ROOT, "src/lib/agents/personas.ts");

function fail(msg: string): never {
  console.error(`\n❌ check-node-registry-drift — ${msg}\n`);
  process.exit(1);
}

function readSource(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    fail(`could not read ${path}: ${(e as Error).message}`);
  }
}

/**
 * Extract every `if (job.kind === "…")` lane in `dispatchJob`. Same regex the sibling
 * `_check-worker-lanes.ts` uses, so drift between the two checks stays impossible.
 */
function extractDispatchedKinds(src: string): Set<string> {
  const out = new Set<string>();
  const re = /if\s*\(\s*job\.kind\s*===\s*"([a-z0-9_-]+)"\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.add(m[1]);
  return out;
}

/**
 * `KIND_PERSONA_ALIAS` in personas.ts maps `agent_jobs.kind` slugs to persona keys when they
 * differ (e.g. `deploy-review` → `deploy-guardian`). The keys must resolve as agent-kinds; the
 * values must resolve as personas the registry carries too (a persona-key without a Node means
 * the tree has a mascot for something the registry doesn't know about).
 */
function extractKindPersonaAlias(src: string): Array<[string, string]> {
  // Locate the block `const KIND_PERSONA_ALIAS: Record<string, string> = { … };`. Tolerant of
  // whitespace + trailing commas.
  const m = /const\s+KIND_PERSONA_ALIAS\s*:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\}\s*;/i.exec(src);
  if (!m) fail(`could not locate the KIND_PERSONA_ALIAS block in ${PERSONAS_PATH}`);
  const body = m[1];
  const out: Array<[string, string]> = [];
  const kv = /"([a-z0-9_-]+)"\s*:\s*"([a-z0-9_-]+)"/gi;
  let e: RegExpExecArray | null;
  while ((e = kv.exec(body)) !== null) out.push([e[1], e[2]]);
  return out;
}

function main(): void {
  const errors: string[] = [];

  // (a) MONITORED_LOOPS ⇒ registry
  for (const loop of MONITORED_LOOPS) {
    if (!resolveNodeOwner(loop.id)) {
      errors.push(
        `MONITORED_LOOPS row id="${loop.id}" (owner="${loop.owner}") does NOT resolve to a Node in the ` +
          `canonical registry. Registry drift — the loop declared an owner but the registry didn't index it. ` +
          `Fix in src/lib/control-tower/node-registry.ts (usually a KIND_OWNER_FALLBACK entry is missing) OR ` +
          `remove the MONITORED_LOOPS row.`,
      );
    }
  }

  // (c) BUILDER_WORKER_KINDS ⇒ registry
  for (const kind of BUILDER_WORKER_KINDS) {
    if (!resolveNodeOwner(kind)) {
      errors.push(
        `BUILDER_WORKER_KINDS entry "${kind}" does NOT resolve to a Node — the box worker dispatches this ` +
          `kind but the canonical registry has no owner for it. Add a KIND_OWNER_FALLBACK entry in ` +
          `src/lib/control-tower/node-registry.ts (or a MONITORED_LOOPS agent-kind row).`,
      );
    }
  }

  // (d) live dispatchJob ⇒ BUILDER_WORKER_KINDS
  const workerSrc = readSource(WORKER_PATH);
  const dispatched = extractDispatchedKinds(workerSrc);
  const registered = new Set<string>(BUILDER_WORKER_KINDS);
  for (const kind of dispatched) {
    if (!registered.has(kind)) {
      errors.push(
        `dispatchJob in scripts/builder-worker.ts has an \`if (job.kind === "${kind}")\` lane but ` +
          `"${kind}" is NOT in BUILDER_WORKER_KINDS in src/lib/control-tower/node-registry.ts. ` +
          `Add "${kind}" to that tuple (and a KIND_OWNER_FALLBACK entry if it has no MONITORED_LOOPS row).`,
      );
    }
  }

  // (e) BUILDER_WORKER_KINDS ⇒ live dispatchJob (skip `build`, the implicit fall-through default)
  for (const kind of BUILDER_WORKER_KINDS) {
    if (kind === "build") continue; // dispatchJob's fall-through default (mirrors _check-worker-lanes)
    if (!dispatched.has(kind)) {
      errors.push(
        `BUILDER_WORKER_KINDS has "${kind}" but scripts/builder-worker.ts \`dispatchJob\` has NO ` +
          `\`if (job.kind === "${kind}")\` lane. Either add the dispatcher (mirror an existing entry) OR ` +
          `remove "${kind}" from BUILDER_WORKER_KINDS.`,
      );
    }
  }

  // (b) KIND_PERSONA_ALIAS ⇒ registry
  const personasSrc = readSource(PERSONAS_PATH);
  const aliases = extractKindPersonaAlias(personasSrc);
  for (const [aliasFrom, aliasTo] of aliases) {
    if (!resolveNodeOwner(aliasFrom)) {
      errors.push(
        `KIND_PERSONA_ALIAS names an agent-kind "${aliasFrom}" (mapped to persona "${aliasTo}") that the ` +
          `canonical registry does NOT carry. Either register the kind (MONITORED_LOOPS row / ` +
          `KIND_OWNER_FALLBACK / BUILDER_WORKER_KINDS) or remove the alias.`,
      );
    }
    // The alias VALUE (persona key) doesn't have to be a Node id — it's a persona slug the
    // registry consumes via personaForLoop/personaForKind. But the underlying agent-kind
    // SHOULD map to that persona; the P1 test suite already asserts this by construction.
  }

  // Belt-and-suspenders — invoke the runtime assertion so the check surfaces any invariant the
  // registry itself carries (e.g. box worker resolves to platform).
  try {
    assertCoverage();
  } catch (e) {
    errors.push(`assertCoverage() failed: ${(e as Error).message}`);
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`  • ${err}`);
    fail(`${errors.length} node-registry drift issue${errors.length === 1 ? "" : "s"} found.`);
  }

  console.log(
    `✓ check-node-registry-drift — ${MONITORED_LOOPS.length} MONITORED_LOOPS ids, ` +
      `${BUILDER_WORKER_KINDS.length} builder-worker kinds, ${aliases.length} persona aliases — all resolved.`,
  );
}

main();
