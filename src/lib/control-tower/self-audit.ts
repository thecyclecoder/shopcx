/**
 * Control Tower — coverage self-audit (control-tower-complete-coverage spec, Phase 2).
 *
 * The detection layer that enforces the "register-or-it's-incomplete" rule by DETECTING
 * violations instead of trusting authors. Two read-only diffs, both fed into the snapshot:
 *
 *   1. CODE ↔ REGISTRY (auditCronCoverage) — enumerate every cron `createFunction` in the
 *      serve route (src/lib/inngest/registered-functions.ts) and diff it against the
 *      MONITORED_LOOPS cron entries. A cron that exists in code but has no monitored-loop
 *      tile (and isn't on the INTENTIONALLY_UNMONITORED_CRONS allow-list) is an
 *      "unregistered loop" → an amber tile, surfaced automatically. This is what makes the
 *      coverage gap visible the moment a new cron lands without a registry row.
 *
 *   2. CODE ↔ INNGEST-REGISTERED (diffInngestRegistered) — the *other* gap, the exact one
 *      that left control-tower-monitor "awaiting first run" for days: a function is in the
 *      serve route but Inngest Cloud never registered it (a deploy didn't re-sync). A
 *      best-effort probe of the Inngest REST API; no-op (status 'unverified') without a
 *      signing key so it never false-alarms locally.
 *
 * READ-ONLY. The AI entry points the spec mentions are the hand-registered inline agents
 * (INLINE_AGENT_IDS) — already MONITORED_LOOPS rows from the agent-coverage spec; there's no
 * runtime `createFunction` set to enumerate them from, so they're not part of the cron diff.
 *
 * See docs/brain/libraries/control-tower-self-audit.md.
 */
import { registeredInngestFunctions } from "@/lib/inngest/registered-functions";
import {
  MONITORED_LOOPS,
  INTENTIONALLY_UNMONITORED_CRONS,
  type MonitoredLoop,
} from "@/lib/control-tower/registry";
import { NODES, getOrphanSightings } from "@/lib/control-tower/node-registry";
import {
  loadKillSwitchMap,
  resolveEffectiveSwitchFromMap,
  type KillSwitchMap,
} from "@/lib/control-tower/kill-switch-resolver";
import type { createAdminClient } from "@/lib/supabase/admin";
import { createAdminClient as makeAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** The Inngest app id (src/lib/inngest/client.ts) — Cloud slugs are `<appId>-<fnId>`. */
const INNGEST_APP_ID = "shopcx";

/** Structural view of an Inngest function object — just what the audit needs. */
interface InngestFnLike {
  id?: () => string;
  opts?: { id?: string; triggers?: Array<{ cron?: string; event?: string }> };
}

/** A cron that exists in code (serve route) — its inngest fn id + the cron expression(s). */
export interface CodeCron {
  id: string;
  crons: string[];
}

/** A cron in code but missing a monitored-loop tile (and not intentionally exempt). */
export interface UnregisteredLoop {
  id: string;
  /** the cron expression(s) the function declares, for the tile's cadence line. */
  cadence: string;
}

/** Result of the in-code ↔ Inngest-registered diff. */
export interface InngestRegistrationDiff {
  /** 'ok' = probed Inngest + diffed · 'unverified' = no signing key / API unreachable (no-op). */
  status: "ok" | "unverified";
  /** fn ids served in code but NOT found in Inngest Cloud's registered set (only when 'ok'). */
  missing: string[];
}

/** The fn id Inngest knows a function by, regardless of the SDK version's getter shape. */
function fnId(fn: InngestFnLike): string | null {
  if (fn.opts?.id) return fn.opts.id;
  try {
    const id = fn.id?.();
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** Enumerate every CRON function in the serve route (functions whose triggers include a cron). */
export function enumerateCodeCrons(): CodeCron[] {
  const out: CodeCron[] = [];
  for (const fn of registeredInngestFunctions as unknown as InngestFnLike[]) {
    const id = fnId(fn);
    if (!id) continue;
    const crons = (fn.opts?.triggers ?? [])
      .map((t) => t?.cron)
      .filter((c): c is string => typeof c === "string" && c.length > 0);
    if (crons.length) out.push({ id, crons });
  }
  return out;
}

/**
 * CODE ↔ REGISTRY diff: cron functions in code with no MONITORED_LOOPS tile and not on the
 * intentional-exemption allow-list. Pure + synchronous (no DB / network).
 */
export function auditCronCoverage(): UnregisteredLoop[] {
  const monitoredCronIds = new Set(
    MONITORED_LOOPS.filter((l) => l.kind === "cron").map((l) => l.id),
  );
  return enumerateCodeCrons()
    .filter((c) => !monitoredCronIds.has(c.id) && !(c.id in INTENTIONALLY_UNMONITORED_CRONS))
    .map((c) => ({ id: c.id, cadence: c.crons.join(", ") }));
}

/** Strip the `<appId>-` prefix Inngest Cloud adds to a function slug → the raw fn id. */
function stripAppPrefix(slug: string): string {
  const prefix = `${INNGEST_APP_ID}-`;
  return slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
}

/**
 * Best-effort probe of the functions Inngest Cloud has registered for this app. Returns a
 * set of raw fn ids, or null when it can't tell (no signing key / API error / unexpected
 * shape) — callers MUST treat null as "unverified", never as "nothing registered".
 */
async function fetchInngestRegisteredFnIds(): Promise<Set<string> | null> {
  const key = process.env.INNGEST_SIGNING_KEY;
  if (!key) return null; // not configured (local / preview) — no-op, no false alarm.
  const base = process.env.INNGEST_API_BASE_URL || "https://api.inngest.com";
  try {
    // The per-app functions endpoint returns a FLAT array of the ~136 registered functions,
    // each keyed by an app-prefixed `id` (e.g. "shopcx-sync-shopify") and no `slug` field.
    // (`GET /v1/apps` 404s — see inngest-registered-diff-endpoint-fix.)
    const res = await fetch(`${base}/v1/apps/${INNGEST_APP_ID}/functions`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const fns: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray((body as { data?: unknown[] })?.data)
        ? (body as { data: unknown[] }).data
        : [];
    const ids = new Set<string>();
    for (const fn of fns) {
      const f = fn as { id?: unknown; slug?: unknown };
      const raw = typeof f.id === "string" ? f.id : typeof f.slug === "string" ? f.slug : null;
      if (raw) ids.add(stripAppPrefix(raw));
    }
    return ids.size ? ids : null; // empty/unexpected ⇒ unverified, not "all missing".
  } catch {
    return null;
  }
}

// The Inngest-registered set changes only on deploy, but the snapshot is rebuilt on every
// ~15s dashboard poll — cache the probe so we hit the Inngest API at most once per TTL
// regardless of poll rate. Per warm serverless instance; a cold start just re-fetches.
let registeredCache: { at: number; ids: Set<string> | null } | null = null;
const REGISTERED_TTL_MS = 5 * 60_000;

async function getInngestRegisteredFnIds(): Promise<Set<string> | null> {
  if (registeredCache && Date.now() - registeredCache.at < REGISTERED_TTL_MS) {
    return registeredCache.ids;
  }
  const ids = await fetchInngestRegisteredFnIds();
  registeredCache = { at: Date.now(), ids };
  return ids;
}

/**
 * CODE ↔ INNGEST-REGISTERED diff: serve-route fn ids that Inngest Cloud hasn't registered
 * (the deploy-didn't-resync gap). Fail-safe — 'unverified' whenever we can't reach/parse
 * the Inngest API, so a missing key or a shape change never pages.
 */
export async function diffInngestRegistered(): Promise<InngestRegistrationDiff> {
  const registered = await getInngestRegisteredFnIds();
  if (!registered) return { status: "unverified", missing: [] };
  const codeIds = (registeredInngestFunctions as unknown as InngestFnLike[])
    .map(fnId)
    .filter((id): id is string => !!id);
  const missing = Array.from(new Set(codeIds)).filter((id) => !registered.has(id));
  return { status: "ok", missing };
}

/** The combined self-audit surfaced in the snapshot. */
export interface CoverageAudit {
  /** crons in code with no monitored-loop tile (amber "unregistered loop: X"). */
  unregistered: UnregisteredLoop[];
  /** in-code ↔ Inngest-registered diff (the deploy-didn't-resync gap). */
  inngestRegistration: InngestRegistrationDiff;
  /** orphan-node audit (orphan-node-self-audit spec, Phase 1). Every finding is a first-class RED. */
  orphans: OrphanFindings;
}

/**
 * Build the full coverage self-audit for the dashboard + monitor. READ-ONLY.
 *
 * `admin` is optional so pure-audit callers (the coverage diffs) still work without a client;
 * when omitted, `auditOrphanNodes` mints its own admin client so the orphan sweep still runs.
 */
export async function buildCoverageAudit(admin?: Admin): Promise<CoverageAudit> {
  const [unregistered, inngestRegistration, orphans] = await Promise.all([
    Promise.resolve(auditCronCoverage()),
    diffInngestRegistered(),
    auditOrphanNodes(admin),
  ]);
  return { unregistered, inngestRegistration, orphans };
}

// ── Orphan-node audit (orphan-node-self-audit spec, Phase 1) ──────────────────────────────

/**
 * A node id is on this allow-list when we intentionally decline to bind it to a `kill_switches`
 * group — the audit skips it in the orphanSwitch sweep. Kept small on purpose: the right answer
 * for almost every real node is a switch group, not an exemption.
 *
 * Each entry MUST carry a short reason (why this node has no switch), following the same
 * convention `INTENTIONALLY_UNMONITORED_CRONS` uses in [[./registry]].
 */
export const INTENTIONALLY_NO_SWITCH: Record<string, string> = {
  // The CEO seat is the OPERATOR that flips every other switch — placing a kill_switches row
  // on `dept:ceo` would let the CEO turn herself off, breaking the recovery path (there'd be
  // no one left to turn her back on). All other departments are legitimately switchable.
  "dept:ceo": "the CEO seat is the operator that flips every other switch — never switchable",
};

/** One pass of the orphan-node self-audit — three parallel lists, each a first-class RED. */
export interface OrphanFindings {
  /** Node ids that `resolveNodeOwnerOrOrphanDefault` fell through to the ORPHAN_OWNER default
   * on (sighted via the `getOrphanSightings` counter). */
  orphanOwner: string[];
  /** Registered node ids NOT on the `INTENTIONALLY_NO_SWITCH` allow-list whose ancestor chain
   * carries no `kill_switches` row — never bound to a switch group. */
  orphanSwitch: string[];
  /** MONITORED_LOOPS entries older than their `livenessWindowMs` since `registeredAt` that
   * have written zero heartbeats past `registeredAt`. */
  orphanHeartbeat: string[];
}

/** Deps for the pure form — every DB / registry read the audit needs, injectable for tests. */
export interface AuditOrphanNodesDeps {
  /** The canonical registry to walk (defaults to `NODES`). */
  nodes: readonly { id: string }[];
  /** Snapshot of `getOrphanSightings()` (id → sighting count). */
  orphanSightings: Record<string, number>;
  /** Snapshot of `public.kill_switches` (already loaded by the caller). */
  killSwitchMap: KillSwitchMap;
  /** The MONITORED_LOOPS entries the heartbeat audit walks (defaults to `MONITORED_LOOPS`). */
  loops: readonly Pick<MonitoredLoop, "id" | "registeredAt" | "livenessWindowMs">[];
  /**
   * Per-loop lookup: has this loop written any beat with `ran_at > registeredAt`? Called ONCE
   * per eligible loop (i.e. registeredAt + livenessWindowMs both set AND the liveness window
   * has fully elapsed since registration) — a non-eligible loop is skipped without a probe.
   */
  hasHeartbeatSinceRegistered: (loopId: string, registeredAtIso: string) => Promise<boolean>;
  /** `Date.now()` — injectable so tests can pin the "elapsed since registered" comparison. */
  now: number;
}

/**
 * Pure form: given the snapshots + a heartbeat probe, compute the orphan findings. Every
 * DB / module-state read is behind a dep, so the test suite can exercise every branch without
 * touching Supabase or the module-level `orphanSightings` counter.
 */
export async function auditOrphanNodesWith(deps: AuditOrphanNodesDeps): Promise<OrphanFindings> {
  // orphanOwner: every id `resolveNodeOwnerOrOrphanDefault` has seen fall through to the default.
  const orphanOwner = Object.keys(deps.orphanSightings);

  // orphanSwitch: every registered node NOT on the allow-list whose ancestor chain carries no
  // kill_switches row. `resolveEffectiveSwitchFromMap` returns `{off:false}` iff no ancestor row
  // exists (a row's presence in kill_switches IS the OFF signal — there are no "row-present-but-on"
  // rows). So `off:false` is precisely "never bound to a switch group".
  const orphanSwitch: string[] = [];
  for (const node of deps.nodes) {
    if (node.id in INTENTIONALLY_NO_SWITCH) continue;
    const eff = resolveEffectiveSwitchFromMap(node.id, deps.killSwitchMap);
    if (!eff.off) orphanSwitch.push(node.id);
  }

  // orphanHeartbeat: MONITORED_LOOPS entries where BOTH `registeredAt` and `livenessWindowMs` are
  // set AND the window has fully elapsed since registration AND the loop has written zero beats
  // since `registeredAt`. A loop without `registeredAt` can't be audited by this rule (there's no
  // "start" to measure elapsed against) — the audit skips it silently.
  const orphanHeartbeat: string[] = [];
  for (const loop of deps.loops) {
    if (!loop.registeredAt || !loop.livenessWindowMs) continue;
    const registeredMs = Date.parse(loop.registeredAt);
    if (!Number.isFinite(registeredMs)) continue;
    if (deps.now - registeredMs <= loop.livenessWindowMs) continue;
    const hasBeat = await deps.hasHeartbeatSinceRegistered(loop.id, loop.registeredAt);
    if (!hasBeat) orphanHeartbeat.push(loop.id);
  }

  return { orphanOwner, orphanSwitch, orphanHeartbeat };
}

/**
 * Live form: mint an admin client (or reuse the caller's), snapshot the registry + kill_switches
 * + orphan-sightings counter, and run the pure audit. READ-ONLY — never writes.
 */
export async function auditOrphanNodes(admin?: Admin): Promise<OrphanFindings> {
  const client = admin ?? makeAdminClient();
  const killSwitchMap = await loadKillSwitchMap(client);
  return auditOrphanNodesWith({
    nodes: NODES,
    orphanSightings: getOrphanSightings(),
    killSwitchMap,
    loops: MONITORED_LOOPS,
    hasHeartbeatSinceRegistered: async (loopId, registeredAtIso) => {
      // ONE index-friendly read per eligible loop (loop_id + ran_at both indexed on
      // public.loop_heartbeats). `limit(1)` is enough — presence is the signal.
      const { data, error } = await client
        .from("loop_heartbeats")
        .select("loop_id")
        .eq("loop_id", loopId)
        .gt("ran_at", registeredAtIso)
        .limit(1);
      if (error || !data) return false;
      return data.length > 0;
    },
    now: Date.now(),
  });
}
