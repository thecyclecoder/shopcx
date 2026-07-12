# libraries/director-leash-guide

The **leash → plain-English guide** generalizer (director-guide-tab spec). Each live director defines its auto-approve envelope as a code-level `LEASH_CATEGORIES` array (the structural gate its runner enforces — [[../libraries/platform-director]] · [[../libraries/growth-director]]). This module is the human-legible mirror of that array, **generalized across every director** (not Platform-only like the old `director-autonomy.tsx`): it maps each category string to a friendly first-person sentence a non-technical founder can skim, so the [[../dashboard/agents|Guide tab]] shows **Growth's** real leash (*reallocate within the approved budget; escalate raising the ceiling / a new ad platform*) and **Platform's** (*approve a confirmed bug fix / a safe additive migration*) — each derived from that director's OWN array, never hardcoded.

**File:** `src/lib/agents/director-leash-guide.ts` (server-only — imports the director modules)

## Exports
- **`getLeashGuide(slug)`** → `LeashGuide` `{ defined, autonomous: LeashLine[], escalates: LeashLine[] }`. Looks the director's `LEASH_CATEGORIES` up in `DIRECTOR_LEASH`, maps each to its `CATEGORY_COPY` line (a fallback line for an un-described category, so nothing renders blank), and pairs it with the escalation rails (per-director extras + the generic rails). A director with **no leash module** returns `{ defined: false }` → the Guide renders a graceful *"leash not yet defined."*
- **`LeashGuide` / `LeashLine`** types.

## Internal config (the generalization point)
- **`DIRECTOR_LEASH`** — `{ platform: LEASH_CATEGORIES, growth: LEASH_CATEGORIES }`. The registry that ties each director to ITS OWN live array. **Adding a leashed director** = add one import line here + a `CATEGORY_COPY` entry per new category.
- **`CATEGORY_COPY`** — `category string → { title, detail }` friendly copy, covering every Platform + Growth category.
- **`GENERIC_ESCALATES`** (every director: destructive/irreversible · new feature or goal · anything unverifiable) + **`DIRECTOR_EXTRA_ESCALATES`** (Growth: raise total budget / new ad platform / non-binary choice; Platform: non-binary choice).

## Callers
- `src/app/api/developer/agents/guide/route.ts` — the owner-gated Guide reader composes `getLeashGuide(slug)` with `getOrgChart()` into the Guide payload.

## North star
The guide is **derived from the code gate**, never a hand-kept second copy — so the plain-English "what she does on her own vs. brings to you" can't drift from the `LEASH_CATEGORIES` the runner actually enforces ([[../operational-rules]] § North star: the supervisor's envelope is legible, not aspirational).

## Related
[[../dashboard/agents]] · [[../libraries/platform-director]] · [[../libraries/growth-director]] · [[../libraries/agent-personas]] · [[../specs/director-guide-tab]]
