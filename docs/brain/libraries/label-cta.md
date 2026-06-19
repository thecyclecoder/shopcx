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

---

[[../README]] · [[../../CLAUDE]] · [[../operational-rules]] · [[../lifecycles/return-pipeline]]
