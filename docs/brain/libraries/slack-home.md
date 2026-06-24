# libraries/slack-home

> **Deprecated (2026-06-24):** the Slack roadmap console this page served has been removed; the roadmap build console is web-app-only now. Retained as a record of the App-Home surface.

App **Home tab** for the former Slack roadmap console — the App Home was a **destination, not a launcher** ([[../specs/slack-home-detail]]). The roadmap board is mirrored onto the ShopCX app's persistent, app-owned Block Kit surface (NOT a message): specs grouped **In progress / Planned / Shipped** with counts + a build-box health header, each a **compact one-line row with a single Details affordance**. Tapping **Details** opens an in-Slack **modal** carrying the spec's full detail — and the build/verify actions live IN the modal, so you review + build a spec end-to-end without leaving Slack. **Pure rendering, no token spend**; rebuilt from `getRoadmap()` / `getSpec()` ([[brain-roadmap]]) on every open, so it never drifts from the brain.

**File:** `src/lib/slack-home.ts`

## Exports

- `HOME` — the `action_id` **prefix** constants (the slug, and phase number, are embedded so buttons stay unique within an actions block):
  - `roadmap_build:{slug}` — Build all
  - `roadmap_build_phase:{slug}:{n}` — build one phase (scoped `instructions`)
  - `roadmap_verify:{slug}` — Mark verified & archive (coalesces into a batch fold-build)
  - `roadmap_details:{slug}` — open the spec-detail modal
  - `roadmap_home_open:{slug}` — legacy URL button (no-op ack; older published views may still carry it)
- `buildHomeView(workspaceId)` → a Block Kit `{ type: "home", blocks }` view. Reads `getRoadmap()` + live [[../tables/agent_jobs]] (`getLatestJobsBySlug`) + `getPendingFolds` + a [[../tables/worker_heartbeats]] health line; reuses a shared `jobChip` for the status chip. Header carries a **counts line** (`In progress N · Planned N · Shipped N`) + a 🟢/🔴 build-box health summary. Each spec is a **single section row** with a **Details** button accessory; **capped per group (20 / 20 / 16)** with a "full board ↗" link so nothing is silently dropped.
- `buildSpecModal(spec, raw, job, fold, owner)` → the **spec-detail modal** view. Renders `slug` · status · chip, **owner · parent**, summary, **phases** (✅/🚧/⏳, numbered to match Build N), the **`## Verification`** how-to-test steps (`extractSpecSection(raw, "Verification")`), and — **for the owner only** — an actions block: **Build all**, per-phase **Build N** (cap 4), and **Mark verified & archive** (only when the spec is shipped with no active build/fold, mirroring the dashboard's `canVerify` gate). "Open in ShopCX" demotes to a small **footer link**.
- `buildSpecConfirmModal(title, text)` → a small confirmation view shown **in place** (`views.update`) after a build/verify action fired from the spec modal.
- `publishHome(token, slackUserId, view)` — thin wrapper over [[slack]] `publishHomeView` (`views.publish`).
- `noticeModal(title, text)` — a small modal for transient Home-tab feedback (Home interactions carry **no channel**, so a modal stands in for the channel-flow ephemeral).

## Wiring

- **Read:** `app_home_opened` (tab `home`) on `src/app/api/slack/events/route.ts` → `buildHomeView` → `publishHome`.
- **Open detail:** `roadmap_details:*` tap on `src/app/api/slack/interactions/route.ts` → `getSpec(slug)` → `buildSpecModal` → [[slack]] `openModal` (uses the `block_actions` `trigger_id`). Anyone may view; the `owner` flag (from [[slack-identity]]) gates whether the action buttons render.
- **Build / verify:** `roadmap_build:*` / `roadmap_build_phase:*` / `roadmap_verify:*` taps (from a Home row OR inside the modal) → owner-gated `queueRoadmapBuild` (`{ verify:true }` for verify) ([[roadmap-actions]]) → **re-publish** the Home view so the chip flips immediately. Feedback: when the action fired from the modal (`payload.view.id` present) the modal is **updated in place** to a confirmation (`updateModal`); otherwise a fresh `noticeModal`. Non-owners → "owners only" notice, nothing runs.

## Conventions

- **Brain stays source of truth** — Home + modal are rebuilt from `getRoadmap()` / `getSpec()` each open + after each queued build (no drift). Slack mirrors the brain, never the reverse.
- Owner gate **twice**: Slack identity ([[slack-identity]]) is a UX filter; [[roadmap-actions]] re-checks server-side regardless of the payload.
- **No outbound hop required** to review or build — the modal is the primary surface; "Open in ShopCX" is just a footer link.
- Never silently truncate — every capped group links out to the `/dashboard/roadmap` board.

## Callers

- `src/app/api/slack/events/route.ts` · `src/app/api/slack/interactions/route.ts`

## Related

[[slack]] · [[slack-identity]] · [[roadmap-actions]] · [[brain-roadmap]] · [[../tables/agent_jobs]] · [[../tables/worker_heartbeats]] · [[../dashboard/roadmap]]

---

[[../README]] · [[../../CLAUDE]]
