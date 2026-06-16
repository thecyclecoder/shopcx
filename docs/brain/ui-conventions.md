# ui-conventions

Cross-cutting UI/UX rules for both the dashboard and the customer-facing storefront. Migrated from agent-memory `feedback_*` entries. Where a rule belongs to a specific lifecycle, it's captured there too (see Cross-references).

## Theme: light only

The app is **forced light** — no dark theme, no OS following. Tailwind v4's `dark:`
variant is redefined as class-based in `globals.css` (`@custom-variant dark
(&:where(.dark, .dark *))`) + `:root { color-scheme: light }`, so every `dark:`
utility (139 files' worth) goes inert unless a `.dark` ancestor exists — which we
never add. Don't reintroduce a `@media (prefers-color-scheme: dark)` block; it
made the app dark on macOS dark mode but light on phones. A future toggle would
add `.dark` to `<html>`.

## Audience-driven defaults

- **Storefront body copy uses 18px+ text and zinc-800+ contrast.** Superfoods Co's core customer is 45-64. Smaller text or lower contrast tanks readability. Headlines can be larger; body never goes below 16px.
- The dashboard is internal-facing and can use 14px / lower contrast for density.

## Storefront pricing & subscription framing

- **Subscribe & Save is the framed default.** The price-table renders "Subscribe & Save" with a "Most Popular" badge, the helper line "80% of customers choose this," and a collapsible explainer for why. One-time purchase is the secondary option, not the primary.
- **Frequency picker is a subtle inline dropdown** defaulting to the selected cadence (Monthly). NOT a row of equal pills — that gave too much visual weight to non-default choices and dropped subscription conversion.

## Product display

- **Never show "Default Title" as a variant name.** Shopify uses "Default Title" as the placeholder for products with no actual variants. Display the product title alone instead. Customer-facing surfaces must never expose this string.

## Dashboard interaction patterns

- **Mutation actions show the animated ActionOverlay**, never a corner toast. The overlay covers the page during the action with loading → success/error states. Toasts disappear; agents need the overlay's confirmation to trust that the mutation landed.
- **Tag overflow wraps or truncates.** Ticket sidebar tags shouldn't blow out the sidebar width — long tag lists wrap to multiple lines or truncate gracefully.

## Dashboard mobile layout (hard invariants)

The dashboard `<main>` (in `dashboard/layout.tsx`) is a flex item and `PullToRefresh` (`src/components/pull-to-refresh.tsx`) wraps every page in a **flex column** and is the **scroll container**. Three rules keep pages from breaking on mobile:

- **Page roots need `w-full`.** A page root styled `mx-auto max-w-screen-2xl …` is a flex item of the PullToRefresh column; `mx-auto` disables flex-stretch, so without `w-full` the container **shrinks-to-fit its widest child** — one wide table drags the *entire page* (stat cards included) past the viewport, and it gets clipped. Always `mx-auto w-full max-w-…` (identical in block context, correct in flex). All dashboard page roots carry `w-full` as of 2026-06-16.
- **`main` has `min-w-0`** and **`PullToRefresh` clips X** (`overflow-x-hidden overflow-y-auto`) so the page itself never scrolls sideways. (`overflow-y:auto` alone computes `overflow-x` to `auto` — it silently becomes a horizontal scroller.)
- **Wide tables get their own `overflow-x-auto` wrapper + a `min-w-[Npx]`** so they scroll *inside their card* (the page clips, so an unwrapped wide table is cut off, not scrollable). `max-width`/`truncate` on a `<td>` is ignored in `table-layout:auto` — put the truncation on an inner `<div>`.

## Cross-page elements

- **Shared components live in `src/components/`.** When a UI element appears in two places (subscription card, customer chip, status badge), it's a component, not inline JSX. Duplicated inline copies drift.

## Customer-facing HTML

- **No inline colors in ticket / customer email bodies.** Plain HTML only — let the dashboard theme apply colors. Inline colors break dark mode + look amateur in some email clients.
- **No markdown.** Email clients don't render it. Use `<strong>` / `<em>` / `<ul>` / `<p>` tags.

## Mini-site & live-chat parity

- **The mini-site renderer and the live-chat embedded forms must produce identical ticket messages.** Only the rendering differs. Whatever the customer sees in the chat widget conversation log is what the agent reading the ticket should see — never different summarizations.

## Identifier discipline in URLs

- **Customer and dashboard URLs use the internal UUID**, never the Shopify/Appstle ID. A saved link to `/dashboard/customers/{uuid}` must survive the Shopify cutover. Same applies to subscription detail pages, ticket pages, etc.

## Cross-references

- [[customer-voice]] — voice / framing / persona rules (customer-facing copy itself).
- [[operational-rules]] — non-UI code conventions (DB joins, address fallback, fraud gates).
- [[lifecycles/storefront-checkout]] — where most storefront UI patterns are applied.
- [[lifecycles/social-comment-moderation]] — comment-page UI patterns (sidebar, confirm-match button, etc.).
