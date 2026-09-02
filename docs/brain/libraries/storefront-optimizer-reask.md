# libraries/storefront-optimizer-reask

Pure decision helper for the [[builder-worker]] storefront-optimizer lane's one bounded re-ask on JSON parse failure. When a box session completes real reasoning but returns unparseable text (not `isError`), the lane asks ONCE more for the JSON envelope only, re-parses, and parks if that second attempt still fails — preventing a formatting slip from discarding completed work. Extracted as a pure function so the logic is testable without importing `scripts/builder-worker.ts` (which boots the worker on import). See [[../specs/storefront-optimizer-re-asks-once-before-parking]] Phase 1.

**File:** `src/lib/storefront-optimizer-reask.ts`

## Exports

### `shouldReAskForJsonEnvelope` — function

```ts
function shouldReAskForJsonEnvelope(input: ReAskDecisionInput): ReAskDecision
```

The single decision the storefront-optimizer lane consults on its terminal fall-through:

- `parsed?.status` is a recognized branch (`idle` / `needs_input` / `needs_build` / `propose`) → `"continue"` (never re-ask; existing branches handle it)
- `isError && !parsed` → `"fail"` (the pre-existing failure branch, untouched)
- `!parsed && !alreadyReAsked` → `"re_ask"` (the one bounded re-ask this phase adds)
- `!parsed && alreadyReAsked` → `"park"` (the pre-existing park, now labeled)

A `parsed` object with a recognized status MUST never re-ask — the existing branches already handle those cases before this helper runs. The `continue` return is the safety net if the caller wires the helper before the status branches.

### `storefrontOptimizerReAskPrompt` — function

```ts
function storefrontOptimizerReAskPrompt(): string
```

The literal instruction handed to the SAME box session on the re-ask. Purposely short — the session already did the analysis in its eleven turns; asking for a fresh diagnosis would double the token spend AND could change the answer. The model has its findings in memory; it just needs to re-emit them in the recognized JSON shape. Forbids re-analysis (names the four recognized statuses, tells the model NOT to re-read / re-run tools or change the answer).

### `ReAskDecisionInput` — interface

```ts
interface ReAskDecisionInput {
  parsed: Record<string, unknown> | null;
  isError: boolean;
  alreadyReAsked: boolean;
}
```

- **`parsed`** — the result of `extractJson(resultText)` on this attempt.
- **`isError`** — the box session's `isError` stream flag on this attempt.
- **`alreadyReAsked`** — has the lane already spent its ONE re-ask on this job? Tracked in-scope, no DB column.

### `ReAskDecision` — type

```ts
type ReAskDecision = "re_ask" | "park" | "fail" | "continue"
```

## Callers

- [[builder-worker]] storefront-optimizer lane — the runner calls `shouldReAskForJsonEnvelope` on the terminal fall-through (the unparseable case, after `isError && !parsed` fails and before the default park). A `"re_ask"` decision triggers a same-session `runBoxSession` with `storefrontOptimizerReAskPrompt()`, re-parsing the result into the existing `idle` / `needs_input` / `needs_build` / `propose` branches unchanged. A `"park"` decision writes the job's log_tail to note a re-ask was attempted, so the next reader knows this is a genuine formatting failure.

## Gotchas

- **Bounded to ONE re-ask per job.** The `alreadyReAsked` flag is tracked in-scope (a local boolean in the lane's runner); there is no DB column. If the re-ask also returns unparseable, the job parks and must be manually inspected.
- **The re-ask reuses the SAME session.** Asking for a new diagnosis would double the token spend and could change the answer. The model has already decided; it just needs to re-emit the answer in JSON.
- **Neighbouring branches untouched.** `isError && !parsed` still fails the job (a broken session can't self-recover on a `--resume`), and a parsed-but-unrecognized status still parks (a semantic failure, not a formatting slip). Only the unparseable + non-error case gets the re-ask.

---

[[../README]] · [[builder-worker]] · [[../specs/storefront-optimizer-re-asks-once-before-parking]] · [[../../CLAUDE]]
