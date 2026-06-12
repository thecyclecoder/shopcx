# libraries/translate

Multi-language detection + translation hooks.

> **Detection anchors on the customer's established language** (added 2026-06-12, in [[../inngest/unified-ticket-handler]]'s `detect-language` step). `detectLanguage` is a single Haiku call and occasionally misfires on forwarded English emails — a French sender name + a quoted support footer once flipped a long-time English customer to `fr`, and we auto-replied in French (Suzanne Doucet). Guard: if the fresh detection is non-English **but the customer has any prior ticket detected as `en`**, we keep `en`. A genuine language-switcher has no English history, so this only suppresses false flips.

**File:** `src/lib/translate.ts`

## File header

```
Lightweight language detection + translation for inbound/outbound
tickets. Used to:
- Detect a customer's language on the first inbound message and
persist it on tickets.detected_language.
- Run any canned outbound text (playbook macros, holding
messages, journey CTAs) through a translation pass so a
Spanish-speaking customer doesn't get an English template.
Both functions hit Claude Haiku — cheap + fast. A typical Spanish
ticket adds two Haiku calls (one detect, one translate per
outbound), pennies of cost. English passes through unchanged with
no API call.
```

## Exports

### `detectLanguage` — function

```ts
async function detectLanguage(text: string, opts: { workspaceId?: string; ticketId?: string } = {},) : Promise<string>
```

### `translateIfNeeded` — function

```ts
async function translateIfNeeded(text: string, targetLang: string, opts: { workspaceId?: string; ticketId?: string } = {},) : Promise<string>
```

### `languageName` — function

```ts
function languageName(code: string) : string
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
