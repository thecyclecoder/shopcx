/**
 * Primary / overflow tiers for the box's Claude account pool — the pure pick logic behind
 * [[../scripts/builder-worker.ts]] `pickNewSessionAccount`, kept in its own module so
 * [[../scripts/builder-worker.account-tier.test.ts]] can pin it without importing the worker's `main()`.
 *
 * WHY (CEO 2026-10-02): RR1 + RR2 are Max plans (the workhorses); RR3 + RR4 were downgraded to Pro and
 * should only take OVERFLOW — work that arrives while every healthy primary is already at its soft
 * concurrency limit, or capped/held. Before this the pool was a flat least-loaded round-robin, so the
 * Pro accounts took ~half of all sessions and hit their (much lower) walls first.
 *
 * Rule for a NEW session (resumes still pin to their owning account — unchanged):
 *   1. a healthy PRIMARY under `primarySoftMax` in-flight sessions — least-loaded, then least-recently-used;
 *   2. else a healthy OVERFLOW account — least-loaded, then LRU;
 *   3. else (no overflow healthy) the least-loaded healthy primary even above the soft max —
 *      better to stack on a Max account than to park work that a healthy account could run.
 */

export const DEFAULT_OVERFLOW_CONFIG_DIRS = ["/home/builder/.claude-third", "/home/builder/.claude-fourth"];
// Concurrent sessions a primary (Max) account carries before new work spills to overflow. Max 20x
// comfortably runs a handful of parallel `claude -p` sessions; tune via BOX_PRIMARY_ACCOUNT_SOFT_MAX.
export const DEFAULT_PRIMARY_SOFT_MAX = 4;

export interface TierAccount {
  configDir: string;
  inFlight: number;
  lastAssignedAt: number;
}

// Parse the overflow list: env BOX_OVERFLOW_CONFIG_DIRS (comma-separated) wins; "none" disables tiers
// (flat pool, the pre-2026-10-02 behaviour); unset → DEFAULT_OVERFLOW_CONFIG_DIRS.
export function parseOverflowDirs(raw: string | undefined): Set<string> {
  if (raw == null || raw.trim() === "") return new Set(DEFAULT_OVERFLOW_CONFIG_DIRS);
  if (raw.trim().toLowerCase() === "none") return new Set();
  return new Set(raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean));
}

export function parsePrimarySoftMax(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_PRIMARY_SOFT_MAX;
}

function byLoadThenLru(a: TierAccount, b: TierAccount): number {
  // Floor at 0 — a briefly-negative counter (reconcile race) must not make an account look emptiest.
  return Math.max(0, a.inFlight) - Math.max(0, b.inFlight) || a.lastAssignedAt - b.lastAssignedAt;
}

// `healthy` = the accounts not capped/held right now. Returns null only when it is empty.
export function pickTieredAccount<T extends TierAccount>(
  healthy: T[],
  overflowDirs: ReadonlySet<string>,
  primarySoftMax: number,
): T | null {
  if (!healthy.length) return null;
  const primaries = healthy.filter((a) => !overflowDirs.has(a.configDir)).sort(byLoadThenLru);
  const overflow = healthy.filter((a) => overflowDirs.has(a.configDir)).sort(byLoadThenLru);
  // A pool with no primaries (or no overflow) is a flat least-loaded pool.
  if (!primaries.length) return overflow[0];
  if (!overflow.length) return primaries[0];
  const underSoftMax = primaries.find((a) => Math.max(0, a.inFlight) < primarySoftMax);
  if (underSoftMax) return underSoftMax;
  return overflow[0];
}
