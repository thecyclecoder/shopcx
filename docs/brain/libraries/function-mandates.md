# libraries/function-mandates

Deterministic resolver that reads a function's charter doc and extracts the mandates declared under `## Mandates`. Used by the [[author-spec]] chokepoint's bare-function-parent auto-anchor (Phase 2) to find an anchor target when a spec is authored with a parent that names a function but no specific mandate.

**File:** `src/lib/function-mandates.ts`

## Why this exists

[[../specs/improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate]] Phase 1 — a deterministic mandate resolver that the [[author-spec]] chokepoint's auto-anchor logic calls when it encounters a bare function parent (`[[../functions/{slug}]]` with no `#mandate` anchor, mandate keyword, or goal reference). The resolver makes the chokepoint self-correcting: instead of throwing `InvalidParentError`, the author-spec pipeline anchors to an appropriate mandate when one exists.

## Exports

- **`FunctionMandate` interface** — a parsed mandate with three fields:
  - `slug` — anchor slug used in `parent_ref` (`{function}#{mandate-slug}`). Preferred source is an explicit `{#slug}` Markdown-Extra anchor on the `### heading` (e.g., `### Autonomous build platform {#build}`), which pins a short, stable slug independent of the heading text. Fallback is kebab-case of the heading (e.g., `Store tech / Shopify` → `store-tech-shopify`).
  - `heading` — the heading text (annotation stripped) — surfaced to the Improve tab so a human sees which mandate was auto-anchored.
  - `body` — the prose between this `### heading` and the next `###` or `##`, used by the best-fit term-overlap chooser when a function has multiple mandates.

- **`parseFunctionMandates(raw)`** → `FunctionMandate[]` — synchronous parser that walks a charter markdown body, finds the `## Mandates` section, and yields a parsed mandate for each `### heading` (starting from the line after `## Mandates` up to the next `##` heading or EOF). Each `### heading {#optional-slug}` line opens a mandate; its body collects every non-heading line until the next `###` or `##`. Returns `[]` when the section is missing or empty. Pure function, no I/O.

- **`resolveFunctionMandates(functionSlug)`** → `Promise<FunctionMandate[]>` — async resolver that reads `docs/brain/functions/{slug}.md` and returns its parsed mandates via `parseFunctionMandates`. Returns `[]` for an unknown function slug (missing file) or a file with no `## Mandates` section. The [[author-spec]] chokepoint calls this when it detects a bare-function parent.

## Caller patterns

**The bare-function-parent auto-anchor in author-spec (Phase 2):**

```ts
import { resolveFunctionMandates, type FunctionMandate } from "@/lib/function-mandates";

const mandates = await resolveFunctionMandates("cs");
// => returns the three CS mandates from docs/brain/functions/cs.md

// If exactly one mandate: anchor there.
// If several: bestFitMandate picks via term overlap with spec title+why+what.
// If zero: fall through to InvalidParentError (nothing to anchor to).
```

**From the Improve tab's auto-fix executor ([[ ../functions/cs]]) for displaying resolved mandates to the human:**

```ts
const { resolveFunctionMandates } = await import("@/lib/function-mandates");
const csMandates = await resolveFunctionMandates("cs");
// Display the mandate list so the human sees which one was chosen.
```

## Gotchas

- **Deterministic, no LLM.** The parser is pure functions; the resolver reads the FS only. No ML, no embeddings, no API calls.
- **Explicit anchor pins the slug.** A `### heading` alone gets kebab-cased; adding `{#custom-slug}` lets a charter owner pin a stable slug independent of future heading rewrites. Stable anchors are load-bearing for the `parentRef` contract.
- **Zero mandates → the throw survives.** When `resolveFunctionMandates` returns `[]`, the [[author-spec]] chokepoint falls through to `assertValidParent`, which throws `InvalidParentError` — the invariant "a parent must resolve to a real mandate or milestone" is preserved. A function with `## Mandates` but only whitespace/comments returns `[]` and triggers the error.
- **Best-fit term overlap is deterministic.** When a function has multiple mandates, [[author-spec]] calls `bestFitMandate(mandates, {title, why, what})` which scores each mandate by the count of DISTINCT terms (lowercased, non-alphanumeric trimmed) from the spec title+why+what that appear in the mandate heading+body. Ties are broken by declaration order in the charter. No randomness; the choice is audit-able.

## Related

[[author-spec]] · [[../specs/improve-tab-spec-author-auto-anchors-bare-function-parent-to-mandate]] · [[../tables/specs]] · [[../functions/platform]] · [[../functions/cs]] · [[../functions/growth]]
