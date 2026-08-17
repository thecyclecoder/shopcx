# libraries/vercel-drain-redact

**Redaction helpers for Vercel log-drain ops diagnostics.** Distills drain objects and endpoints to allowlisted, safe-to-log summaries that omit secrets (userinfo, search params, hash, pathname segments, response bodies, headers).

**Ship:** [[../specs/redact-vercel-drain-diagnostics]] (2026-08-17) · Hotfix: [[../specs/redact-vercel-drain-path-secrets]] (2026-08-17) · **Export:**

- `endpointOf(drain: DrainLike): string | null` — extract the raw endpoint from a drain object (`delivery.endpoint` > `endpoint` > `url`), or return null.
- `redactedEndpoint(endpoint: string | null | undefined): string` — safe display for a drain endpoint: `protocol//host[:port]` plus a fixed `/<path-redacted>` marker when the URL carries a non-root pathname. The pathname itself is NEVER emitted — a drain endpoint can carry a shared secret / signed token / customer id in a path segment (e.g., `https://logs.example.com/ingest/sk_live_ABC123`). Userinfo, search params, and hash are also stripped. Returns `<unparseable-endpoint>` if the URL cannot be parsed.
- `summarizeDrain(drain: DrainLike): string` — allowlisted summary including `id`, `name`, `status`, and `redactedEndpoint`. Never emits raw JSON bodies, response headers, or the endpoint's secrets.
- `DrainLike` — type union for drain-like objects (id, name, status, disabled, delivery, endpoint, url).

**Wired:** `scripts/_delete-self-pointing-vercel-drain.ts` (uses `summarizeDrain` to replace raw `JSON.stringify(before)` logging) · `scripts/_check-no-self-pointing-log-drain.ts` (uses `redactedEndpoint` in the violation report while keeping host classification against the parsed `hostOf(endpoint)`).

**Invariant:** The self-pointing HOST classification must still use the parsed host (never the redacted display) so a URL with credentials in userinfo cannot dodge the guard. See [[../integrations/vercel-log-drain]].

**Testing:** `src/lib/vercel-drain-redact.test.ts` (6 tests verifying the redaction predicates — userinfo, search params, hashes, and pathname segments all stripped; a path-segment token embedded in a non-root pathname is never emitted; empty/unparseable URLs return sentinels; only allowlisted fields appear in summarizeDrain summaries).

## Gotchas

- The redacted endpoint is **display only** — if you need the actual host for routing or classification, always call `endpointOf()` and parse the raw URL via `new URL()`, never parse the redacted display string. Critically, the `/<path-redacted>` marker is fixed text, not parsed content.
- Pathname text is not emitted, only a fixed `/<path-redacted>` marker — a path segment can carry a shared-secret, signed token, or customer id. This is not just a userinfo/search/hash guard; the entire pathname is opaque.
- A drain object may carry its endpoint in any of three places (Vercel's API surfaces it inconsistently): `delivery.endpoint` (preferred), `endpoint`, or `url`. Use `endpointOf()` to extract it.

## Related

[[../integrations/vercel-log-drain]] · [[../specs/replace-log-drain-with-in-process-onrequesterror]]
