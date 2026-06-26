# dashboard/developer

The owner-only **Developer portal** — the home + contextual sidebar takeover for the whole build-OS area (goals, the spec pipeline, the autonomous agents that ship it, and the gates that keep it honest).

**"Developer" is a portal, not a collapsing section.** In the main sidebar it's a single top-level item (owner-only); clicking it lands on the **Overview** (`/dashboard/developer`) and the sidebar **swaps the main tree for the developer sub-nav** — the same UX as a director profile ([[agents]] `/dashboard/agents/[role]`), so you're "inside" the developer area until you click **← Dashboard** to leave. This keeps the main nav short and lets the developer sub-nav grow without bloating the top level.

**Route:** `/dashboard/developer` (client, owner-only) — the Overview
**Sidebar:** main tree → **Developer** (top-level, owner-only) → enters the portal.

## The takeover (sidebar)

Implemented in `src/app/dashboard/sidebar.tsx`, driven by [[../libraries/developer-nav]]:

- **Pathname-driven**, not context-registered. A director profile registers its sub-nav via `setNav` (the section-nav context (`src/lib/section-nav-context.tsx`)) because it's one page; the developer area spans a **fixed set of routes** across `/dashboard/agents/*`, `/dashboard/roadmap/*`, `/dashboard/developer/*`, `/dashboard/brain`, `/dashboard/branches`, so the sidebar detects membership with `isInDeveloperPortal(pathname)` and renders the takeover — no per-page registration to forget, and it persists as you move between surfaces.
- Renders: **← Dashboard** (exit) · the **Developer** title · an **Overview** link · then the surfaces **grouped under headings** (`DEVELOPER_GROUPS` — **Org · Development · Resources**), each link with its icon + a live **badge** (Approvals escalated to CEO · Security findings · Regressions · Human QA · open Branches — the same counts the old section badges read). Active highlighting is most-specific-wins (`isDeveloperHrefActive`).
- A director-profile takeover (`sectionNav`) wins when both could apply — a director profile (`/dashboard/agents/[role]`) sets `sectionNav`, so it shows the director takeover even though the path is inside the portal; the **Org** group's non-profile routes (Message Board / Org Chart / Directors / Agents) don't set it, so they get the developer takeover.

## The Overview page

`src/app/dashboard/developer/page.tsx` — the portal home: card sections (**one per group**, [[../libraries/developer-nav]] `DEVELOPER_GROUPS`), each a heading + one card per surface (icon, one-line description, same live badge). Click a card → that surface (and the sidebar stays scoped to the portal). Owner-gated; the badges come from the same lightweight count endpoints the sidebar polls (`/api/developer/approvals?count=1`, `/api/developer/security-tests?count=1`, `/api/developer/spec-test/human-queue`, `/api/branches`).

## The surfaces (cards), by group

- **Org** (moved here off the main tree) — [[agents|Message Board]] (`/dashboard/agents`) · Org Chart · Directors · Agents (the box worker lanes).
- **Development** — [[control-tower|Goals]] · [[roadmap|Pipeline]] · the Build box · [[control-tower|Control Tower]] · [[approvals|Approvals]] · the Taxonomy map · the Message Center · [[../libraries/spec-test-agent|Spec Tests]] · Human QA · Regressions · [[security-tests|Security tests]] · Branches.
- **Resources** — [[../README|Brain]].

The groups live **once** in [[../libraries/developer-nav]] `DEVELOPER_GROUPS` — add a surface to a group and it appears in both the takeover (under its heading) and the Overview cards.

## Related

[[../libraries/developer-nav]] · the section-nav context (`src/lib/section-nav-context.tsx`) · [[approvals]] · [[security-tests]] · [[control-tower]] · [[roadmap]] · [[agents]] · [[../ui-conventions]]
