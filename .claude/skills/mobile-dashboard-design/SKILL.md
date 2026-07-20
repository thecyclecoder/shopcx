# mobile-dashboard-design

**When:** building OR reviewing any dashboard page under `src/app/dashboard/**` — especially data-dense ones (tables, metric rows, funnels, grids). The founder uses the dashboard on a phone, so every such page must be legible + fully visible at **390px** (iPhone). Reach for this whenever a page has rows of numbers, a table, or side-by-side columns.

**Why:** the dashboard shell has a specific overflow model that **silently CLIPS anything wider than the viewport** (no horizontal scroll — the content past the right edge is just invisible on mobile). Two systemic traps produce it:

1. **The cross-axis flex trap (fixed at the layout level 2026-07-20).** Every page renders inside `PullToRefresh`'s `flex flex-col` wrapper ([[../../../src/components/pull-to-refresh.tsx]]). A page is a flex item on that column's **CROSS axis**, where `min-width:auto` lets it size to its own **min-content** (e.g. a wide data table) instead of the viewport → it renders wider than the phone and the scroll container's `overflow-x-hidden` clips the right edge. **`min-w-0` does NOT fix a cross-axis item — a common wrong instinct; `w-full` does.** The layout now applies `[&>*]:w-full [&>*]:min-w-0` to constrain every page, so a NEW page inherits the guard. But a page that establishes its OWN inner overflow (a wide row/table) can still clip — that's what the rules below prevent.

2. **Data rows/tables that don't reflow.** A horizontal metrics row (fixed `w-14` cells × N) or a wide `<table>` overflows a phone. Hiding it with `hidden sm:flex` hides the **data** — the exact bug on the Ad Testing page (Spend/CPM/CTR/… were `hidden sm:flex`, so a phone showed no results at all).

## Rules — apply to every dashboard page

1. **Cards, not tables, on mobile for data-dense rows.** Desktop: the compact inline row / table (`hidden sm:flex` or `hidden sm:table`). Mobile: each record is a **stacked, labeled card** — a 2–3-col metric grid or key:value list (`sm:hidden`). NEVER just hide the data. (Ad Testing is the reference: desktop inline `Metric` row + mobile `MobileMetric` grid.)
2. **The `min-w-0` chain.** Every flex/grid item that contains shrinkable content (text, `truncate`) needs `min-w-0`. Flex/grid items default to `min-width:auto` and won't shrink below their content — the #1 cause of horizontal overflow inside a row.
3. **No fixed-width data cells on mobile.** `w-14`-style fixed columns are desktop-only. A mobile metric cell fills its grid column (`min-w-0` + `truncate`).
4. **Long text wraps or truncates.** `break-words` for wrapping copy; `truncate` (with a bounded / `min-w-0` parent) for single-line. A long headline, URL, or account name must never force the row wider than the card.
5. **Less padding on mobile:** `p-4 sm:p-6`.
6. **Fewer columns on the narrowest screens:** `grid-cols-2 sm:grid-cols-3`.

## Verify — the MANDATORY 390px check

Before shipping a dashboard page, confirm **no content is cut off at the right edge** and there's **no horizontal scroll** at a phone width. Two ways:

- **Live (Claude Chrome extension connected):** resize the window to 390px, then run the overflow probe in the page context —
  ```js
  const vw = document.documentElement.clientWidth;
  [...document.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > vw + 1).map(e => (e.tagName + ' ' + e.className))
  ```
  Any results = elements past the edge → fix them (usually a missing `min-w-0` / a fixed-width row / a `w-full` gap).

- **Headless (no live page / not logged in):** build a **self-contained repro HTML** of the layout chain + the page's markup (Tailwind Play CDN `https://cdn.tailwindcss.com`), render it in **Playwright** (`node_modules/.bin/playwright` is installed) at 320 / 390 / 430px, and probe `getBoundingClientRect().right > document.documentElement.clientWidth`. This is exactly how the 2026-07-20 layout fix was diagnosed (the probe found the page root at **661px inside a 390px viewport**) and verified (`w-full` → 390px, 0 overflow, across 320/390/1280px). Keep the repro + probe in the scratchpad; don't commit them.

## The layout overflow model (reference)

```
dashboard/layout.tsx
  <main className="min-w-0 flex-1 overflow-hidden ...">
    PullToRefresh
      <div className="... overflow-x-hidden overflow-y-auto">   ← scroll container: horizontal overflow is CLIPPED, not scrollable
        <div className="flex h-full flex-col [&>*]:w-full [&>*]:min-w-0">   ← constrains each page to the viewport (the 2026-07-20 fix)
          {your page}                                            ← must not establish its OWN inner overflow
```

## Related

[[../../../src/components/pull-to-refresh.tsx]] (the shell fix) · [[../../../src/app/dashboard/layout.tsx]] · [[../../../src/app/dashboard/analytics/ad-testing/page.tsx]] (the pilot — table→card metrics) · [[../ad-testing-results/SKILL.md]] · [[../../../docs/brain/ui-conventions.md]]
