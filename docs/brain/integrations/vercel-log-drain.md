# integrations/vercel-log-drain

The **Vercel Log Drain → `/api/webhooks/vercel-logs`** feed ([[../specs/error-feed-monitoring]] Phase 1): prod runtime errors / 500s pushed to us in real time, grouped + rate-limited into the Control Tower "Vercel errors" panel ([[../dashboard/control-tower]]).

**Endpoint:** `src/app/api/webhooks/vercel-logs/route.ts` · records via [[../libraries/control-tower]] (`error-feed.ts` → `recordError`, `source='vercel'`)

## How it works

1. **The owner creates the drain** via the Vercel API with our token (the lone Vercel setup — done **after** the endpoint ships): JSON drain, `delivery: batch`, filtered to error / 500-level runtime logs, URL = `https://shopcx.ai/api/webhooks/vercel-logs`, with a generated secret. *(Token has the `log-drains` scope — verified.)*
2. **Vercel POSTs batches** of log objects, signed `x-vercel-signature` = **HMAC-SHA1(rawBody)** with the drain secret.
3. The endpoint **verifies the signature** (timing-safe) against `VERCEL_LOG_DRAIN_SECRET`, **re-filters** to error/500-level entries (belt-and-suspenders over the drain's own filter — `level==='error'|'fatal'` or `statusCode/proxy.statusCode >= 500`), **groups the batch** by `(path, status, normalized message)`, and calls `recordError` once per group with an `occurrences` count.
   - The re-filter also **drops bare Lambda lifecycle/REPORT wrappers** (`isBareLifecycle`): a 5xx whose entire message is `START`/`END`/`REPORT RequestId` scaffolding + the bare `[METHOD] path status=NNN` proxy line carries no error body — it's the non-actionable platform wrapper around a failure the function *already* logged via `console.error` (which has its own stable signature + repair spec). Capturing it too minted a second, redundant signature per failure (`vercel:ebdf493a37c60c34`). A lifecycle block that *also* carries a real message/stack (e.g. "Task timed out") is **not** bare and is still captured.
   - …and **drops Node Web-Streams client-abort teardown noise** (`isAbortedStreamNoise`, factored into [[../libraries/control-tower]] `error-feed.ts` so any feed can reuse it): when a visitor aborts an SSR stream mid-flight (client disconnect, `status:0` — the response never completed), Node core's Web-Streams teardown can race and emit a `level:'error'` log with **no frame in our code** — the documented TransformStream race (nodejs/node#62040) surfaced by Next.js streaming. Gated tightly so it only swallows this signature: requires `status === 0` **and** a message in the abort family (`transformAlgorithm is not a function`, `Invalid state: Controller is already closed`, `ERR_STREAM_PREMATURE_CLOSE`/`aborted`) **and** an `at ignore-listed frames`-only stack (zero frames in our code). Minting an open incident for it paged owners on a healthy PDP (`vercel:801aa4e3922198d3`). A real error with a frame in our code is **kept**. See [[../specs/error-feed-drop-aborted-stream-noise]].
4. `recordError` records into [[../tables/error_events]] and **pages owners on a new signature or a re-firing spike**, rate-limited to one page per incident per 30 min (a burst of the same 500 = one page).

## Credentials / env

| Env | What | Who sets it |
|---|---|---|
| `VERCEL_LOG_DRAIN_SECRET` | the drain's signing secret (HMAC-SHA1) — **required**; without it the endpoint returns `503` (can't verify) | owner, at drain creation |
| `VERCEL_LOG_DRAIN_VERIFY` | the `x-vercel-verify` ownership token (optional) — echoed on `GET` + when Vercel presents it, so the drain's wiring check passes | owner, if Vercel requires it |

## Endpoints (this app)

- **`GET /api/webhooks/vercel-logs`** — Vercel's drain-ownership probe; echoes the `x-vercel-verify` token (presented header or `VERCEL_LOG_DRAIN_VERIFY`), else `200 ok`.
- **`POST /api/webhooks/vercel-logs`** — the signed log batch. `503` if no secret configured, `401` on bad signature, `400` on bad JSON, else `{ received, incidents }`.

## Gotchas

- **Signature is SHA1, not SHA256** (Vercel Log Drains) — over the **raw** request body (read via `request.text()` before any JSON parse).
- **Grouping happens twice** — once client-side per batch (so 500 identical entries in one POST = one `recordError` call with `occurrences: 500`), then again on `(source, signature)` in `error_events`.
- **Setup is the owner's**, but only the drain creation — the endpoint + grouping/alerting ship in the build. Until the secret is set the endpoint is live but refuses (`503`).
- **One failure used to land twice** — the app's `console.error` (actionable, own signature) *and* a bare Lambda lifecycle/REPORT block (non-actionable). `isBareLifecycle` now suppresses the latter so a single failed request mints one signature, not two. See [[../specs/vercel-capture-strip-lambda-lifecycle]].

## Related

[[../specs/error-feed-monitoring]] · [[../libraries/control-tower]] · [[../tables/error_events]] · [[../inngest/inngest-failure-capture]] · [[../dashboard/control-tower]] · [[../libraries/notify-ops-alert]]
