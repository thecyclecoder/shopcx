# libraries/agent-personas

The **reusable director-persona + SVG-mascot design system** ([[../specs/agents-hub-role-inboxes]] Phase 2) and the org-chart/inbox readers behind the [[../dashboard/agents|Agents hub]]. ONE reskinnable source of truth for the org-chart cast that every later milestone reuses — the gamified board (M3) and the live director's board posts (M4) render the same characters from here, so names/mascots/colors are never hardcoded across components ([[../operational-rules]]: reskinnable personas).

**Files:** `src/lib/agents/personas.ts` · `src/lib/agents/org-chart.ts` · `src/lib/agents/inbox.ts` · `src/components/agents/mascots.tsx` · `src/components/agents/persona-chip.tsx`

## `personas.ts` — the cast (reskin here)

- **`PERSONAS: Record<string, AgentPersona>`** — keyed by `functions/*.md` slug + the special `ceo` seat: 🛠️ **Ada**/platform · 🚀 **Max**/growth · 🎨 **Iris**/cmo · 💬 **June**/cs · 🧲 **Theo**/retention · 👑 **You**/ceo. Each `AgentPersona` = `{ key, name, role, emoji, personality, mascotId, chip, dot, ring, accent }`. Colors are **explicit Tailwind class strings** (not interpolated) so the compiler never purges them.
- **`getPersona(slug, label?)`** — resolves a persona by slug; **falls back to a neutral persona** for an unknown director, so adding a new `functions/*.md` reskins the hub with **no code change** (brain-driven). Reskin a director by editing one entry — that is the template every other director inherits.
- Pure config (no server imports) → **safe to import from client components**.

## `mascots.tsx` — inline SVG avatars

- **`<Mascot id={MascotId} />`** — one friendly rounded-face SVG component per persona (`ada|max|iris|june|theo|ceo|default`), each with a role-hinting accessory (hard hat, rocket fins, paint palette, speech bubble, magnet horns, crown). **No asset pipeline** — inline SVG so M3's board can render them directly. Color inherits via `currentColor` from the persona's `accent`.

## `persona-chip.tsx` — the building blocks

- **`<PersonaAvatar persona />`** — the colored mascot tile. **`<PersonaChip persona />`** — a name/role pill. **`<StatusBadge status />`** — the live/autonomous badge; M1 default is `offline` ("routes to CEO"), flipped per-function by M2.

## `org-chart.ts` — the CEO → Directors → Workers reader (server-only)

- **`getOrgChart(): Promise<OrgChart>`** — builds the tree entirely from the brain: **directors** = `functions/*.md` via [[brain-roadmap]] `getFunctions()` (title, summary, mandates with spec counts, owned goals); the **CEO** seat carries the finite `goals/*.md` via `getGoals()`; **workers** = the box [[../tables/agent_jobs]] lanes, derived from the `agent-kind` `MONITORED_LOOPS` in the Control Tower [[control-tower|registry]] (which already carry an `owner` function) grouped under their owning director. **No hand-maintained second copy of the org chart** — one read, no drift. Server-only (brain-roadmap reads the bundled fs copy at request time). Used by `GET /api/developer/agents`.

## `inbox.ts` — the three-tab shell config (client-safe)

- **`INBOX_TABS`** — Messages · Approval Requests · Daily Summaries, each declaring the **reserved [[../tables/dashboard_notifications]] `type`** that fills it: `agent_message` (M3 board) · `agent_approval_request` (M2 routed queue) · `agent_daily_summary` (M3/M4 EOD recap). **`AGENT_INBOX_TYPES`** scopes the CEO inbox query so the generic bell's notifications stay out; **`tabForType(type)`** buckets a row. The backing store is `dashboard_notifications` (it already has type/title/body/link/read/dismissed) — **no new table** for the shell. M1 ships the shell + filters + empty states; M2/M3/M4 emit the rows.

## Why this exists

The [[../goals/devops-director]] goal stands up the Agent Org (CEO → Directors → Workers). M1 is the foundation surface; the persona/mascot system is the **design-system piece every milestone reuses**, and the org-chart + inbox readers are the **brain-driven data layer** under the hub — so the org chart is always a projection of `functions/` + `goals/`, never a copy.

## Related

[[../dashboard/agents]] · [[../specs/agents-hub-role-inboxes]] · [[../goals/devops-director]] · [[brain-roadmap]] · [[control-tower]] · [[../tables/dashboard_notifications]] · [[../tables/agent_jobs]] · [[../functions/platform]] · [[../operational-rules]]
