# libraries/research/index

Research-and-heal pipeline entry. See [[../lifecycles/research-and-heal]].

**File:** `src/lib/research/index.ts`

## File header

```
Research recipe registry + runner.
Each recipe lives under src/lib/research/recipes/<slug>.ts and gets
registered below. Recipes are TypeScript (not config) — see
[[../lifecycles/research-and-heal]] for the design rationale.
```

## Exports

### `listRecipes` — function

```ts
function listRecipes() : ResearchRecipe[]
```

### `getRecipe` — function

```ts
function getRecipe(slug: string) : ResearchRecipe | null
```

### `runRecipe` — function

```ts
async function runRecipe(recipeSlug: string, ticketId: string, options: { triggeredBy: "ai_analysis" | "manual" | "heal_reverify"; sourceAnalysisId?: string | null; args?: Record<string, unknown>; },) : Promise<
```

### `RECIPE_REGISTRY` — const

```ts
const RECIPE_REGISTRY: Record<string, ResearchRecipe>
```

## Callers

_No internal callers found via static scan._

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
