# `src/lib/json-escape-repair.ts`

**Owner:** platform · **Callers:** `scripts/builder-worker.ts` `extractJson` (every box lane that parses an agent's final JSON verdict).

## Exports

- **`repairInvalidJsonEscapes(s: string): string`** (pure). Doubles every backslash that is not a legal JSON escape (`\" \\ \/ \b \f \n \r \t \uXXXX`) and leaves legal escapes untouched. `extractJson` calls it as a second attempt only after a plain `JSON.parse` fails.

## Why

Box agents (graders especially) quote regexes in their `reasoning` strings, e.g. `\bid\s+like\b`. `\s` is not a JSON escape, so the whole verdict failed to parse and the job parked `needs_attention` with "agent-grade produced no parseable decisions". This happened on 2026-11-27 and again on 2026-11-28, and each time Ada escalated it to the CEO. Pinned by `src/lib/json-escape-repair.test.ts`.
