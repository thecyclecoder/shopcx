# libraries/label-cta

Single source of truth for rendering prepaid return-label URLs as clickable CTA buttons (never raw S3 links).

**File:** `src/lib/label-cta.ts`

## Exports

### `ctaButton(url, label)` — function

Returns the styled button markup (Outlook-safe `<table>`; also works in the chat widget's `dangerouslySetInnerHTML`). Imported by [[../lifecycles/return-pipeline]]'s executor side (`action-executor.ts`) for `{{label_url}}` substitution.

### `renderLabelUrlsAsButtons(html)` — function

Safety-net sweep over a **finished** outbound message. Converts any *bare* `easypost-files.s3…` URL (one the AI pasted as plain text) into a `ctaButton`. A negative lookbehind skips URLs already inside an `href`/attribute, so a properly-rendered button is never double-wrapped.

## Callers

- `src/lib/action-executor.ts` — `ctaButton` for `{{label_url}}` → button substitution.
- `src/lib/inngest/unified-ticket-handler.ts` — `sendWithDelay` runs `renderLabelUrlsAsButtons()` on **every** outbound message (after translation), so no code path can leak a raw label URL.

## Why

The `{{label_url}}` placeholder path only handles a single label and only when the AI uses the token. When the AI free-texts label URLs (re-delivering existing labels, or after the single-token path breaks under multiple labels), customers got long literal S3 strings in the body — Traci Studebaker, ticket `1b62b00f`, 2026-06-19 (also the 3-returns incident; see [[../operational-rules]] § Returns). The sink-level sweep makes "raw label URL in a customer message" impossible regardless of code path.

## Status / open work

**✅ Label URL alone in paragraph now converts to button (2026-07-24)** — The `BARE_LABEL_URL_RE` negative lookbehind previously excluded `>`, causing a URL that sits alone on its own line (rendered as `<p>https://…</p>`) to skip conversion and ship as a raw S3 link. The regex now keeps only `["'=]` in the lookbehind, so a URL preceded by a tag-close converts to a button while URLs already inside `href` attributes remain protected. Test cases in `src/lib/label-cta.test.ts` harden the converter. Fixes ticket a00b0c22 and the Traci Studebaker class of crisis-return rendering bugs. See [[label-cta-button-render-url-alone-in-paragraph]].

---

[[../README]] · [[../../CLAUDE]] · [[../operational-rules]] · [[../lifecycles/return-pipeline]]
