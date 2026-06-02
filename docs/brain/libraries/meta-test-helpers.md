# libraries/meta-test-helpers

Mock helpers for Meta API in tests.

**File:** `src/lib/meta-test-helpers.ts`

## File header

```
Shared helpers for the Meta app-review test endpoints. Each
endpoint exercises one permission's gating API surface so a
Meta reviewer can click "Run test" in our Settings UI and see
the real call go through their logs.
On any HTTP non-2xx Meta puts the actual error in the body —
we surface it verbatim so the reviewer can correlate the
fbtrace_id in their tooling.
```

## Exports

### `loadMetaCreds` — function

```ts
async function loadMetaCreds(workspaceId: string) : Promise<MetaCreds |
```

### `callMeta` — function

```ts
async function callMeta(step: string, method: "GET" | "POST" | "DELETE", url: string, body?: URLSearchParams,) : Promise<MetaTestCall>
```

### `META_GRAPH_VERSION` — const

```ts
const META_GRAPH_VERSION
```

### `MetaCreds` — interface

### `MetaTestCall` — interface

### `MetaTestResult` — interface

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
