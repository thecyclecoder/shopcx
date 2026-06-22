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
import { MONITORED_LOOPS, INTENTIONALLY_UNMONITORED_CRONS } from "@/lib/control-tower/registry";

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
    const res = await fetch(`${base}/v1/apps`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const apps: unknown[] = Array.isArray(body)
      ? body
      : Array.isArray((body as { data?: unknown[] })?.data)
        ? (body as { data: unknown[] }).data
        : [];
    const ids = new Set<string>();
    for (const app of apps) {
      const fns = (app as { functions?: unknown[] })?.functions;
      if (!Array.isArray(fns)) continue;
      for (const fn of fns) {
        const f = fn as { slug?: unknown; id?: unknown };
        const raw = typeof f.slug === "string" ? f.slug : typeof f.id === "string" ? f.id : null;
        if (raw) ids.add(stripAppPrefix(raw));
      }
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
}

/** Build the full coverage self-audit for the dashboard + monitor. READ-ONLY. */
export async function buildCoverageAudit(): Promise<CoverageAudit> {
  const [unregistered, inngestRegistration] = await Promise.all([
    Promise.resolve(auditCronCoverage()),
    diffInngestRegistered(),
  ]);
  return { unregistered, inngestRegistration };
}
