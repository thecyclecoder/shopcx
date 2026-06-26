# dashboard/developer

The owner-only **Developer portal** — the home + contextual sidebar takeover for the whole build-OS area (goals, the spec pipeline, the autonomous agents that ship it, and the gates that keep it honest).

**"Developer" is a portal, not a collapsing section.** In the main sidebar it's a single top-level item (owner-only); clicking it lands on the **Overview** (`/dashboard/developer`) and the sidebar **swaps the main tree for the developer sub-nav** — the same UX as a director profile ([[agents]] `/dashboard/agents/[role]`), so you're "inside" the developer area until you click **← Dashboard** to leave. This keeps the main nav short and lets the developer sub-nav grow without bloating the top level.

**Route:** `/dashboard/developer` (client, owner-only) — the Overview
**Sidebar:** main tree → **Developer** (top-level, owner-only) → enters the portal.

## The takeover (sidebar)

Implemented in `src/app/dashboard/sidebar.tsx`, driven by [[../libraries/developer-nav]]:

- **Pathname-driven**, not context-registered. A director profile registers its sub-nav via `setNav` (the section-nav context (`src/lib/section-nav-context.tsx`)) because it's one page; the developer area spans a **fixed set of routes** across `/dashboard/roadmap/*`, `/dashboard/developer/*`, `/dashboard/brain`, `/dashboard/branches`, so the sidebar detects membership with `isInDeveloperPortal(pathname)` and renders the takeover — no per-page registration to forget, and it persists as you move between surfaces.
- Renders: **← Dashboard** (exit) · the **Developer** title · an **Overview** link · then one link per [[../libraries/developer-nav]] `DEVELOPER_NAV` entry, each with its icon + a live **badge** (Approvals escalated to CEO · Security findings · Regressions · Human QA · open Branches — the same counts the old section badges read). Active highlighting is most-specific-wins (`isDeveloperHrefActive`).
- A director-profile takeover (`sectionNav`) still wins if both could apply (they never overlap — `/dashboard/agents/*` isn't a developer route).

## The Overview page

`src/app/dashboard/developer/page.tsx` — the portal home: a card grid, **one card per developer surface** ([[../libraries/developer-nav]] `DEVELOPER_NAV`), each with its icon, a one-line description, and the same live badge. Click a card → that surface (and the sidebar stays scoped to the portal). Owner-gated; the badges come from the same lightweight count endpoints the sidebar polls (`/api/developer/approvals?count=1`, `/api/developer/security-tests?count=1`, `/api/developer/spec-test/human-queue`, `/api/branches`).

## The surfaces (cards)

[[control-tower|Goals]] · [[roadmap|Pipeline]] · the Build box · [[control-tower|Control Tower]] · [[approvals|Approvals]] · the Taxonomy map · the Message Center · [[../libraries/spec-test-agent|Spec Tests]] · Human QA · Regressions · [[security-tests|Security tests]] · [[../README|Brain]] · Branches. The list lives **once** in [[../libraries/developer-nav]] — add a developer surface there and it appears in both the takeover and the Overview cards.

## Related

[[../libraries/developer-nav]] · the section-nav context (`src/lib/section-nav-context.tsx`) · [[approvals]] · [[security-tests]] · [[control-tower]] · [[roadmap]] · [[agents]] · [[../ui-conventions]]
