/**
 * Predeploy guard: fail the build if any Vercel drain configured on the team
 * `delivery.endpoint`s back at a host THIS project serves — the "self-feeding"
 * shape that cost $1,850/mo and 433.6M edge requests in Aug 2026 (see
 * docs/brain/integrations/vercel-log-drain.md and the parent spec
 * replace-log-drain-with-in-process-onrequesterror).
 *
 * Vercel log drains cannot filter by log level — sampling rules filter by
 * environment + request path prefix + percentage only. A drain pointed at the
 * app it is draining therefore emits its own lambda logs, which are drained
 * again: 968.95 GB / 433.6M requests = 2,400 bytes/request (a JSON log batch,
 * not user traffic). The in-process replacement is `instrumentation.ts` →
 * `onRequestError` → `recordError` on `source: 'vercel'`. This guard is the
 * rail that turns the lesson into an invariant so no future drain can silently
 * re-point at us — a disabled drain is still a configured drain someone can
 * flip back on.
 *
 * Shape:
 *   - GET https://api.vercel.com/v1/drains?teamId=<TEAM_ID>
 *   - For each drain, parse `delivery.endpoint` and inspect the URL's host.
 *   - FAIL if the host is `shopcx.ai`, ends in `.shopcx.ai`, or is a
 *     `*.vercel.app` alias belonging to project `prj_80PnLIjdKT4YAxITnbjkTCgbP0Qv`.
 *
 * SKIP (exit 0) when the environment carries no Vercel API token — a local
 * predeploy or a credential-less CI run must not fail closed, because a guard
 * that fails on a missing credential just teaches everyone to ignore it. The
 * team's active credential-carrying predeploy (the deployment pipeline) is the
 * one that actually enforces the invariant.
 *
 * Wired into `predeploy:static` in package.json.
 */
import { VERCEL_PROJECT_IDS } from "@/lib/vercel-project";
import { errText } from "@/lib/error-text";

const { PROJECT_ID, TEAM_ID } = VERCEL_PROJECT_IDS;

/** Cost arithmetic printed on failure so whoever trips the guard sees the stakes. */
const COST_STAKES =
  "Aug 2026 self-feeding drain cost $1,850/mo and 433.6M edge requests " +
  "(968.95 GB / 433,580,313 requests = 2,400 bytes per request — a JSON log " +
  "batch, not page traffic; invocations were 2.00x requests because the sink " +
  "route used after()). Replacement: instrumentation.ts → onRequestError → " +
  "recordError. See docs/brain/integrations/vercel-log-drain.md.";

type Drain = {
  id?: string;
  name?: string;
  delivery?: { endpoint?: string | null } | null;
  // Older drain shapes carry the endpoint at the top level.
  endpoint?: string | null;
  url?: string | null;
};

type ProjectInfo = {
  alias?: Array<{ domain: string }> | null;
  targets?: Record<string, { alias?: string[] | null } | null> | null;
};

function vercelToken(): string | null {
  return process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN || null;
}

async function fetchDrains(token: string): Promise<Drain[]> {
  const url = `https://api.vercel.com/v1/drains?teamId=${encodeURIComponent(TEAM_ID)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Vercel drains API failed: ${res.status} ${body.slice(0, 500)}`,
    );
  }
  const payload = (await res.json()) as unknown;
  // The API historically returns either an array or an object with a `drains` array.
  if (Array.isArray(payload)) return payload as Drain[];
  if (payload && typeof payload === "object" && Array.isArray((payload as { drains?: unknown }).drains)) {
    return (payload as { drains: Drain[] }).drains;
  }
  return [];
}

async function fetchProjectAliases(token: string): Promise<Set<string>> {
  const url = `https://api.vercel.com/v9/projects/${encodeURIComponent(
    PROJECT_ID,
  )}?teamId=${encodeURIComponent(TEAM_ID)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Vercel project API failed: ${res.status} ${body.slice(0, 500)}`,
    );
  }
  const info = (await res.json()) as ProjectInfo;
  const aliases = new Set<string>();
  for (const a of info.alias ?? []) {
    if (a?.domain) aliases.add(a.domain.toLowerCase());
  }
  for (const target of Object.values(info.targets ?? {})) {
    for (const a of target?.alias ?? []) {
      if (a) aliases.add(a.toLowerCase());
    }
  }
  return aliases;
}

function endpointOf(drain: Drain): string | null {
  return drain.delivery?.endpoint || drain.endpoint || drain.url || null;
}

function hostOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export type Violation = {
  drainId: string;
  drainName: string;
  endpoint: string;
  host: string;
  reason: string;
};

export function classifyHost(
  host: string,
  projectAliases: Set<string>,
): { selfPointing: boolean; reason: string } {
  if (host === "shopcx.ai" || host.endsWith(".shopcx.ai")) {
    return { selfPointing: true, reason: "shopcx.ai domain we serve" };
  }
  if (host.endsWith(".vercel.app") && projectAliases.has(host)) {
    return {
      selfPointing: true,
      reason: `*.vercel.app alias of project ${PROJECT_ID}`,
    };
  }
  return { selfPointing: false, reason: "" };
}

async function main(): Promise<void> {
  const token = vercelToken();
  if (!token) {
    console.log(
      "check-no-self-pointing-log-drain — skipped (no VERCEL_API_TOKEN / VERCEL_TOKEN in env; " +
        "credential-less runs cannot query Vercel — the deploy pipeline enforces this rail).",
    );
    return;
  }

  let drains: Drain[];
  let aliases: Set<string>;
  try {
    [drains, aliases] = await Promise.all([
      fetchDrains(token),
      fetchProjectAliases(token),
    ]);
  } catch (err) {
    // A read failure against Vercel isn't a self-pointing drain — degrade to skip
    // (with a clear message) rather than fail the deploy on a transient upstream.
    console.log(
      `check-no-self-pointing-log-drain — skipped (Vercel API read failed: ${errText(err)}).`,
    );
    return;
  }

  const violations: Violation[] = [];
  for (const drain of drains) {
    const endpoint = endpointOf(drain);
    if (!endpoint) continue;
    const host = hostOf(endpoint);
    if (!host) continue;
    const verdict = classifyHost(host, aliases);
    if (!verdict.selfPointing) continue;
    violations.push({
      drainId: drain.id ?? "(unknown)",
      drainName: drain.name ?? "(unnamed)",
      endpoint,
      host,
      reason: verdict.reason,
    });
  }

  if (violations.length === 0) {
    console.log(
      `check-no-self-pointing-log-drain — clean (${drains.length} drain(s) inspected, none self-pointing).`,
    );
    return;
  }

  console.error(
    `\nX check-no-self-pointing-log-drain — ${violations.length} self-pointing drain(s):\n`,
  );
  for (const v of violations) {
    console.error(`   drain ${v.drainId} "${v.drainName}"`);
    console.error(`      endpoint: ${v.endpoint}`);
    console.error(`      host:     ${v.host}  (${v.reason})`);
  }
  console.error(
    "\n   A drain that POSTs into the app it is draining is a feedback loop by " +
      "\n   construction: every delivery emits its own lambda logs, which are drained " +
      "\n   again. " +
      COST_STAKES +
      "\n\n   Repoint the drain at an external log sink, or delete it — the app's own " +
      "\n   error feed is served in-process by instrumentation.ts (onRequestError → " +
      "\n   recordError on source: 'vercel').\n",
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("check-no-self-pointing-log-drain — unexpected failure:", err);
  process.exit(1);
});
