# `src/lib/agents/agent-kpis.ts` — the per-agent KPI SDK

The second **supervision** layer above [[agent-grader]] (per-action grades) and [[agent-coaching]] (the learning loop) — every agent kind gets a KPI page that answers two distinct questions: **"is this agent ON IT?"** (liveness / posture) and **"is it WINNING?"** (outcomes). Motivated by Cleo ([[storefront-optimizer-agent]]): while experiments run she correctly does NOT propose, so the box board reads as *idle* when she is actually monitoring N experiments + blocked because every surface has a live test. The KPI page makes that legible. Spec `docs/brain/specs/agent-kpi-pages-cleo-first.md`.

Built as a **REGISTRY of per-agent-kind definitions with a GENERIC FALLBACK** — any agent kind without a bespoke definition still gets a sane KPI page from day one (pulled from [[../tables/agent_jobs]] activity + [[../tables/agent_action_grades]] + [[../tables/agent_coaching_log]]). Pure reads, no writes; server-only (`createAdminClient`).

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `computeAgentKpis` | `({ workspaceId, agentKind, admin? }) → Promise<AgentKpis>` | The one public entrypoint. Dispatches to the registered bespoke definition for the given `agentKind`, or the generic fallback. Returns `{ agentKind, generatedAt, headline: KpiCard[], tiers: KpiTier[] }`. |
| `bespokeAgentKinds` | `() → string[]` | Introspection — the set of agent kinds that carry a hand-written definition. Currently `['storefront-optimizer']`. |
| `KpiCard` type | `{ key, label, value, unit?, tone: 'good'\|'neutral'\|'bad', trend?: {dir, pct?}, subtitle?, source }` | One card the page renders. The SDK sets `tone` from the underlying signal (e.g. a lever-coverage of 0% is `bad`, not `neutral`) — the page renders it, it does not re-interpret. |
| `KpiTier` type | `{ key, label, cards: KpiCard[] }` | One section on the page. Cleo has four (`on-it` / `cadence` / `outcome` / `quality`); the generic fallback has two (`activity` / `quality`). |
| `AgentKpis` type | `{ agentKind, generatedAt, headline: KpiCard[], tiers: KpiTier[] }` | The whole payload the route/page consume. |

## The registry pattern

```ts
// src/lib/agents/agent-kpis.ts
const REGISTRY: Record<string, KpiDefinition> = {
  "storefront-optimizer": storefrontOptimizerDefinition,
};
```

Each entry is a `KpiDefinition` — an async function `({workspaceId, admin}) → {headline, tiers}` that pulls from real tables (probe first — **database is the spec**) and returns the tiered structure. Cleo's def sources from [[../tables/storefront_experiments]] · [[../tables/storefront_ltv_metrics]] · [[../tables/storefront_experiment_variants]] · [[../tables/storefront_lever_importance]] · [[../tables/storefront_campaign_grades]] · [[../tables/agent_jobs]].

### Adding a bespoke definition for a new agent kind

1. Write a `KpiDefinition` inside `agent-kpis.ts` (mirror `storefrontOptimizerDefinition`) — pull from the tables that carry the agent's real work; set `tone` from the signal, not "neutral" everywhere; include a `subtitle` + `source` on every card so the tooltip explains where the number came from.
2. Register it in `REGISTRY`.
3. The page (`/dashboard/agents/{kind}/kpi`) picks it up automatically — no page/route changes needed.

Every card MUST cite its source (rendered as a tooltip on the `<KpiCard>`) so the founder can trace a number back to the row. A card with a `null` value is legal (source has no data yet) — the page renders it as `—` rather than hiding, so the KPI's absence is visible.

## Leading vs. lagging

Until an agent's proxy is calibrated + it has sufficient traffic, **Tier 2 (cadence) + Tier 4 (quality/learning) LEAD** and **Tier 3 (outcome) LAGS** — a fresh agent shows movement on Tier 2/4 long before Tier 3 has enough signal to trust. The page should not surface Tier 3 as the headline while `calibration.state !== 'ready'`; Cleo's headline pairs the On-it posture with predicted-LTV/visitor precisely so both a live-and-monitoring day and a first-lift day are legible.

## Callers

- `src/app/api/workspaces/[id]/agent-kpis/route.ts` — the owner-gated `GET` route (auth + `workspace_members`) that returns the SDK's structure keyed by `?kind=`. The KPI page is the only caller.
- `src/app/dashboard/agents/[role]/kpi/page.tsx` — the per-agent KPI page (Phase 2). Renders the `<KpiCard>` / `<PostureCard>` grid from the SDK's tiered structure. Fetches the route via `useWorkspace()` + `?kind={role}`, polls every 30s. Its route `layout.tsx` wraps `{children}` in `<Suspense fallback={null}>` to satisfy `cacheComponents` (a `"use client"` page reading dynamic data via `useParams`).
- `src/components/agents/kpi-card.tsx` — `<KpiCard>` (label + big value + unit + trend arrow + tone color + source tooltip) and `<PostureCard>` (the richer Tier-1 variant — status dot + posture line + experiments-in-flight + awaiting-owner).

## Discoverability (Phase 3)

The `/dashboard/agents/[role]` **profile detail page** carries a `KPIs →` link in the top-right header (next to `reports to …`) for every director + worker (skipped for the CEO, who is not an agent). So from the Agents hub — either the org-tree, the workers roster, or the left role nav — **Cleo's KPI page is reachable in two clicks**: hub → click `storefront-optimizer` → click `KPIs →`. The same path works for any other agent kind (build / repair / ticket-improve / …), which is exactly where the generic fallback proves its keep.

## Gotchas

- **Pure reads.** The SDK holds NO write path. Do not add mutations here — every write lives in the corresponding domain library (grades in [[agent-grader]], coaching in [[agent-coaching]], experiments in [[storefront-optimizer-agent]]). The KPI page is a supervision surface, not a control surface.
- **Optional `admin` argument.** `computeAgentKpis({ admin })` accepts an injected admin client so a script (probe / test) can share a connection; the route lets the SDK create one.
- **The generic fallback is required.** Every agent kind without a bespoke definition MUST render a page — the fallback pulls from [[../tables/agent_jobs]] + [[../tables/agent_action_grades]] + [[../tables/agent_coaching_log]] so a *newly-registered* kind gets a real page from day one. Do not gate the page on `bespokeAgentKinds().includes(kind)`.
- **`tone` is set by the signal.** A 0% coverage is `bad`, not `neutral`; an experiment count of 0 is `neutral`, not `bad`. Set tone in the definition — the page does not re-interpret.

## Related

[[agent-grader]] · [[agent-coaching]] · [[storefront-optimizer-agent]] · [[../tables/agent_jobs]] · [[../tables/agent_action_grades]] · [[../tables/agent_coaching_log]] · [[../tables/storefront_experiments]] · [[../tables/storefront_ltv_metrics]] · [[../tables/storefront_lever_importance]] · [[../tables/storefront_campaign_grades]] · [[../dashboard/agents]] · [[agent-personas]]
