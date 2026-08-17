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
 * Safe display for a drain endpoint: `protocol//host[:port]/pathname` only.
 * Strips userinfo (username:password@), search params, and hash — the three
 * places a shared secret / API key is most likely to live in a delivery URL.
 * Returns `<unparseable-endpoint>` when the input can't be parsed as a URL.
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
  const path = parsed.pathname || "/";
  return `${parsed.protocol}//${host}${path}`;
}

/**
 * Allowlisted, safe-to-log summary of a drain. Never emits the raw JSON body, response
 * headers, or the endpoint's userinfo/search/hash. Includes:
 *   - id
 *   - name
 *   - status (or a disabled=true|false fallback)
 *   - the redacted endpoint (protocol + host + pathname)
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
