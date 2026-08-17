/**
 * One-off: DELETE the self-pointing Vercel log drain `drn_kQkATjjmtVrTnRrj`
 * ("SHOPCX Control Tower") that used to POST to https://shopcx.ai/api/webhooks/vercel-logs.
 *
 * Phase 2 of replace-log-drain-with-in-process-onrequesterror. The drain was
 * `status=disabled` via the Vercel API on 2026-08-12 so nothing is being delivered,
 * BUT — per Phase 2's intent — a disabled drain is a setting someone can flip
 * back. The route it targeted is gone (deleted in the same phase), and the
 * predeploy guard `scripts/_check-no-self-pointing-log-drain.ts` refuses to
 * ship as long as any configured (even disabled) self-pointing drain exists on
 * the team. The only way to satisfy the invariant is to remove the drain from
 * Vercel entirely; this script does that idempotently:
 *
 *   1. GET the drain by id — if 404, we're already done (log and exit 0).
 *   2. DELETE it.
 *   3. GET again to confirm the 404. Fail loud if the DELETE claimed success
 *      but the drain is still there.
 *
 * Requires VERCEL_API_TOKEN (or VERCEL_TOKEN). Reads TEAM_ID from the same
 * constants file as everything else that talks to the Vercel API.
 *
 * The cost stakes so nobody reads this and undoes it: the self-feeding drain
 * cost $1,850/mo and 433.6M edge requests in Aug 2026 (968.95 GB / 433,580,313
 * requests = 2,400 bytes per request — a JSON log batch, not page traffic;
 * invocations were exactly 2.00x requests because the sink route used after()).
 * The in-process replacement is instrumentation.ts → onRequestError → recordError.
 */
import { VERCEL_PROJECT_IDS } from "../src/lib/vercel-project";
import { errText } from "../src/lib/error-text";

const { TEAM_ID } = VERCEL_PROJECT_IDS;
const DRAIN_ID = "drn_kQkATjjmtVrTnRrj";

/**
 * Vercel-drain response bodies can carry delivery configuration (custom headers,
 * signing/auth material, URL userinfo/query with tokens). NEVER print the raw
 * object. Extract an allowlisted, safe-to-log distillation and a redacted
 * endpoint (host + pathname only — no userinfo, no search params, no hash).
 * Returns a compact single-line string suitable for `console.log`.
 */
function redactedEndpoint(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "<none>";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

function summarizeDrainSafe(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "<empty>";
  const o = obj as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.id === "string") parts.push(`id=${o.id}`);
  if (typeof o.name === "string") parts.push(`name=${o.name}`);
  if (typeof o.status === "string") parts.push(`status=${o.status}`);
  parts.push(`endpoint=${redactedEndpoint(o.endpoint)}`);
  return parts.join(" ");
}

function vercelToken(): string {
  const t = process.env.VERCEL_API_TOKEN || process.env.VERCEL_TOKEN;
  if (!t) {
    throw new Error(
      "VERCEL_API_TOKEN (or VERCEL_TOKEN) not set — this script must run in an environment " +
        "with a token that can DELETE team drains.",
    );
  }
  return t;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function drainUrl(id: string): string {
  return `https://api.vercel.com/v1/drains/${encodeURIComponent(id)}?teamId=${encodeURIComponent(
    TEAM_ID,
  )}`;
}

async function main(): Promise<void> {
  const token = vercelToken();

  // Step 1 — check whether the drain still exists.
  const probe = await fetch(drainUrl(DRAIN_ID), { headers: authHeaders(token) });
  if (probe.status === 404) {
    console.log(
      `delete-self-pointing-vercel-drain — drain ${DRAIN_ID} already absent (404); nothing to do.`,
    );
    return;
  }
  if (!probe.ok) {
    // Do NOT echo the raw response body — a Vercel error payload can carry request-echo
    // metadata (auth headers, tokens in the queried URL). Status alone is diagnostic enough.
    throw new Error(`probe GET failed: ${probe.status}`);
  }
  const before = await probe.json().catch(() => ({}));
  console.log(
    `delete-self-pointing-vercel-drain — found drain: ${summarizeDrainSafe(before)}`,
  );

  // Step 2 — DELETE.
  const del = await fetch(drainUrl(DRAIN_ID), {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!del.ok) {
    // Same rule: no raw response body in the thrown message.
    throw new Error(`DELETE failed: ${del.status}`);
  }
  console.log(`delete-self-pointing-vercel-drain — DELETE returned ${del.status}.`);

  // Step 3 — confirm the drain is truly gone.
  const confirm = await fetch(drainUrl(DRAIN_ID), { headers: authHeaders(token) });
  if (confirm.status !== 404) {
    throw new Error(
      `confirm GET after DELETE expected 404, got ${confirm.status}`,
    );
  }
  console.log(
    `✅ delete-self-pointing-vercel-drain — drain ${DRAIN_ID} deleted and confirmed 404.`,
  );
}

main().catch((err) => {
  console.error(`delete-self-pointing-vercel-drain — failed: ${errText(err)}`);
  process.exit(1);
});
