---
name: new-agent
description: Use to add a NEW cast member (director or worker agent) to the ShopCX org chart — the reskinnable persona + avatar + org-placement wiring, so you never re-explain the convention. Triggered by "create/add a new agent named X who reports to Y and does Z", "give the {tool} a persona", or standing up an agent identity before its behavior is built. Creates IDENTITY + PLACEMENT; the agent's BEHAVIOR (its job-kind worker logic / spec) is designed separately.
---

# new-agent

Stand up a new member of the agent cast — name, persona, photoreal avatar, and correct placement under its director in the org chart. **One source of truth drives every surface** (`src/lib/agents/personas.ts`); wiring is ~4 touch points. This skill is IDENTITY + PLACEMENT only — what the agent *does* (its Inngest cron / `agent_jobs`-kind worker logic, its own skill, its spec) is a separate build.

## The cast model (read first)

- **`src/lib/agents/personas.ts`** — the ONE reskinnable registry. `PERSONAS[key]` where `key` is a **function slug** (directors: `platform`→Ada, `growth`→Max, `cmo`→Iris, `cs`→June, `retention`→Theo; + `ceo`→Henry) or an **`agent_jobs` kind** (workers: `repair`→Rafa, `spec-review`→Vale, `storefront-optimizer`→Cleo, …). Every component reads this — names/photos/colors are never hardcoded elsewhere.
- **Hierarchy:** CEO → Directors (one per `functions/*.md` slug) → Workers (each keyed by its job-kind, attached to a director via the Control Tower registry's `owner`). A worker appears under a director because its registry entry says `owner: "<director slug>"` — NOT because of anything in personas.ts.
- **`getOrgChart()`** (`src/lib/agents/org-chart.ts`) assembles the tree from three roster sources: (1) registry entries with an `owner`, (2) `personaKind` crons, (3) live `agent_jobs` kinds in the recent window. To make a worker ALWAYS visible (not only when it has recent job rows), give it a registry entry with a `personaKind`.

## Inputs to pin down before wiring

1. **Name** — short, distinct, on-pattern (workers often echo their role: Rafa/Repair, Vera/Verify, Reese/Spec-Drift). Not already in `PERSONAS`.
2. **Director** — which function slug it reports to (`growth`, `platform`, …). This decides `owner`.
3. **Kind slug** — the `agent_jobs.kind` / persona key (kebab-case, e.g. `research`, `migration-fix`). Broad enough for the agent's full mandate, not just its first task.
4. **Role label** — the org-chart seat text (e.g. "Research", "Storefront CRO").
5. **Pronouns + personality + voice** — she/he/they; a one-line `personality`; optionally a first-person `voice` (only messageable personas need `voice`).
6. **Accent color** — pick a Tailwind color family NOT already used by a sibling under the same director (grep the file for `dot: "bg-<color>-500"`). Stay in/near the director's family for lineage (Growth = green/emerald) but distinct from siblings.

## Procedure

### 1. Persona entry — `src/lib/agents/personas.ts`
Add one `PERSONAS["<kind>"]` object, mirroring an existing worker of the same director. Fields: `key`, `name`, `role`, `emoji`, `personality`, `pronouns`, `mascotId: "default"`, `avatarUrl: \`${AV}<name-lowercased>-<kind>.jpg?v=1\``, and the five color classes (`chip`/`dot`/`ring`/`accent` — explicit strings so Tailwind keeps them). If the agent is user-messageable, add a first-person `voice`. If it's a worker with a precise mandate, add a `responsibilities: string[]` (see the `RESPONSIBILITIES` block lower in the file — workers carry the most precise list).

### 2. Org placement — `src/lib/control-tower/registry.ts`
Add (or extend) a `MONITORED_LOOPS` entry for the agent's driving loop with:
```
{ id: "<its-cron-or-lane-id>", kind: "cron", owner: "<director slug>", label: "...", description: "...", expectedCadence: "...", livenessWindowMs: N * MIN, personaKind: "<kind>" }
```
`owner` + `personaKind` are what surface it as a worker **under that director** in the org tree. If the agent has no loop yet (behavior not built), you can still add a minimal placeholder entry so it renders — but prefer wiring this when its real loop lands.

### 3. Grade / approval routing — `ownerFunctionForKind` in `src/lib/agents/approval-inbox.ts`
Map the kind → the director's function so grading + approval routing resolve to the right director (mirror the existing `m["gap-grade"] = "growth"` lines). Skip only if the agent is never graded and never raises approvals.

### 4. Avatar — Nano Banana Pro → `agent-avatars` bucket
**House style (every gen MUST match the cast — the canonical copy is at the top of `personas.ts`):** a PHOTOREALISTIC portrait PHOTOGRAPH of a real-looking person — tight CLOSE CROP (top of head at the top of the frame, cropped just below the collarbone; the face fills the frame), looking at camera, soft editorial lighting, plain neutral background. These are **STYLISH, fashion-forward people with real personal taste** — modern, distinctive outfits + hair + energy, **NOT boring corporate headshots: NO blazers, NO stiff LinkedIn vibe**. Give each a genuinely different look, visually distinct from same-gender cast members. NEVER a cartoon / illustration / 3D render / stylized art; NO cheesy props or gimmicks.

Generate + upload with a one-off script (`scripts/_gen-<name>-avatar.ts`) using `_bootstrap`:
```ts
import { loadEnv } from "./_bootstrap"; loadEnv();
import { generateNanoBananaProCombine } from "../src/lib/gemini";
import { createClient } from "@supabase/supabase-js";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // ad-tool workspace (has Gemini creds)
const { buffer, mimeType } = await generateNanoBananaProCombine({ workspaceId: WS, prompt: "<house-style prompt>" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
await sb.storage.from("agent-avatars").upload("<name>-<kind>.jpg", buffer, { contentType: mimeType, upsert: true });
```
The filename MUST match the `avatarUrl` path in step 1. On a REPLACEMENT of an existing avatar, bump `?v=N` in personas.ts so clients re-fetch.

### 5. Gate + verify
- `npx tsc --noEmit` clean.
- Confirm the avatar 200s as an image at its public URL.
- Load `/dashboard/agents/org-chart` (or `getOrgChart()`) and confirm the new agent renders under the right director with the photo (not the fallback mascot).
- If a director-level addition (new `functions/*.md` slug), also author the brain `functions/` page.

## Notes
- **Identity ≠ behavior.** This skill makes the agent *exist and appear correctly*. Building what it *does* (the Inngest fn / box worker lane / its own operating skill / its spec) is separate — design that as a spec (`submit-spec`).
- **Reskin, don't fork.** Renaming/re-photographing an existing agent = edit its one `PERSONAS` entry + re-run step 4 with a bumped `?v=`.
- **Color collisions** are the easy mistake — always grep sibling `dot:`/`accent:` under the same `owner` before picking.
