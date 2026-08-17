// Redaction helpers for Vercel log-drain diagnostics printed by the two ops scripts
// (`scripts/_delete-self-pointing-vercel-drain.ts` + `scripts/_check-no-self-pointing-log-drain.ts`).
//
// The API responses these scripts touch can carry secrets — the drain object may include an
// endpoint with a shared-secret query param, header material, or an Authorization-like value in
// userinfo; the raw JSON body may also expose fields the ops team never intended to print
// (see the security review of replace-log-drain-with-in-process-onrequesterror). These helpers
// distill the diagnostic to an allowlisted, safe-to-log summary.
//
// The self-pointing HOST classification MUST still use the parsed host (already handled by
// `hostOf` in the check script) — never the redacted display — so a URL with credentials in
// userinfo can't dodge the guard.

export type DrainLike = {
  id?: string | null;
  name?: string | null;
  status?: string | null;
  disabled?: boolean | null;
  delivery?: { endpoint?: string | null } | null;
  endpoint?: string | null;
  url?: string | null;
};

/** Return the raw endpoint on a drain (delivery.endpoint > endpoint > url), or null. */
export function endpointOf(drain: DrainLike): string | null {
  return drain.delivery?.endpoint || drain.endpoint || drain.url || null;
}

/**
 * Safe display for a drain endpoint: `protocol//host[:port]` plus a fixed
 * `/<path-redacted>` marker when the URL carries a non-root pathname. The
 * pathname itself is NEVER emitted — a drain endpoint can carry a shared
 * secret / signed token / customer id in a path segment
 * (e.g. `https://logs.example.com/ingest/sk_live_ABC123`), and the ops
 * scripts must not print that segment to CI or worker logs. Userinfo
 * (username:password@), search params, and hash are stripped for the same
 * reason. Returns `<unparseable-endpoint>` when the input can't be parsed
 * as a URL.
 *
 * Host classification (e.g. self-pointing-drain guard in
 * `scripts/_check-no-self-pointing-log-drain.ts`) MUST still run against
 * the raw parsed URL — this helper is a DISPLAY, not a classifier.
 */
export function redactedEndpoint(endpoint: string | null | undefined): string {
  if (!endpoint) return "<no-endpoint>";
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "<unparseable-endpoint>";
  }
  const host = parsed.host.toLowerCase();
  const rawPath = parsed.pathname || "";
  const hasPath = rawPath.length > 0 && rawPath !== "/";
  const pathMarker = hasPath ? "/<path-redacted>" : "";
  return `${parsed.protocol}//${host}${pathMarker}`;
}

/**
 * Allowlisted, safe-to-log summary of a drain. Never emits the raw JSON body, response
 * headers, or the endpoint's userinfo/search/hash. Includes:
 *   - id
 *   - name
 *   - status (or a disabled=true|false fallback)
 *   - the redacted endpoint (protocol + host, with `/<path-redacted>` marker
 *     when the URL had a non-root pathname — the pathname text itself is never
 *     emitted, because a drain path segment can carry a secret / token / id)
 */
export function summarizeDrain(drain: DrainLike): string {
  const id = drain.id ?? "<no-id>";
  const name = drain.name ?? "<unnamed>";
  const statusRaw =
    drain.status ??
    (typeof drain.disabled === "boolean" ? (drain.disabled ? "disabled" : "enabled") : null);
  const status = statusRaw ?? "<no-status>";
  const endpoint = redactedEndpoint(endpointOf(drain));
  return `id=${id} name="${name}" status=${status} endpoint=${endpoint}`;
}
