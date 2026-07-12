# ShopCX.ai

The retention operating system for Superfoods Company. Replaces Gorgias + Siena AI + Appstle + Klaviyo with a unified, multi-tenant SaaS platform.

- Domain: https://shopcx.ai · GitHub: thecyclecoder/shopcx · Vercel: dylan-ralstons-projects/shopcx
- Stack: Next.js 16 (App Router), Supabase (Postgres + RLS + pgvector), Inngest, Vercel, Resend, Twilio, EasyPost, Braintree, Avalara, Shopify, Appstle, Klaviyo, Meta Graph, Anthropic, OpenAI embeddings.

## Authoritative reference: `docs/brain/`

`docs/brain/` is the system map. Six folders covering every table, Inngest function, integration, library file, journey, playbook, lifecycle, and recipe. **Read it before grepping `src/`.** Start at `docs/brain/README.md`.

| Folder | What |
|---|---|
| `tables/` | One page per `public.*` table — columns, FKs, queries, gotchas |
| `inngest/` | One page per `src/lib/inngest/*.ts` — triggers + events + table writes |
| `integrations/` | One page per external API — auth, credentials, endpoints, retries |
| `libraries/` | One page per `src/lib/*.ts` — exports, signatures, callers |
| `journeys/` + `playbooks/` | Per-row in `journey_definitions` / `playbooks` tables |
| `lifecycles/` | Long-form end-to-end traces of major flows |
| `recipes/` | How-to pages for common operational tasks |
| `functions/` + `goals/` | Org-chart functions (permanent owners + mandates) and finite company goals/BHAGs. The work hierarchy: **Function → (Mandate \| Goal) → Spec**. See [project-management.md](docs/brain/project-management.md). |

**Hard rule:** every new feature / table / Inngest function / integration / library file must land in `docs/brain/` in the same PR. Code without a brain page is incomplete.

**Planning + tracking work also lives in the brain.** Specs for in-flight features go in `docs/brain/specs/{slug}.md` with phase emojis (⏳ planned · 🚧 in progress · ✅ shipped). Every spec declares an **owner** (one `functions/` function — the DRI) + a **parent** (a function mandate or a goal milestone) — no orphan specs. Start a build session with `/goal do everything in docs/brain/specs/{slug}.md`. When a spec is fully shipped, its content folds into the relevant lifecycle/table/library/inngest/integration/dashboard/recipe pages, and the spec file is deleted. Lifecycle pages carry a "Status / open work" block at the bottom showing shipped state. Full workflow: [docs/brain/project-management.md](docs/brain/project-management.md).

## Local conventions

These can't live in a wiki page — they're project-wide invariants:

- **⭐ North star — supervisable autonomy.** Every autonomous tool optimizes a proxy and can reach a degenerate state that destroys the real objective (Goodhart). So: a tool optimizes a bounded proxy; a role agent owns the objective and supervises the tool; the CEO owns company objectives (CEO → role agent → tool). Every autonomous tool MUST surface its reasoning, respect its supervisor's guardrails (hitting a rail = escalate, not execute), and answer to an objective-owner — never a silent proxy-optimizer. See [operational-rules.md § North star](docs/brain/operational-rules.md).
- **Database is the spec.** Status enums, column shapes — probe before assuming. See [Probing technique](docs/brain/README.md#probing-technique). The PM flow reads `public.specs` + `public.spec_phases` via [specs-table](docs/brain/libraries/specs-table.md) `getSpec` / `listSpecs` — never a `docs/brain/specs/*.md` fetch (enforced in CI by [scripts/_check-pm-md-reads.ts](scripts/_check-pm-md-reads.ts); call graph: [pm-flow-data-sources](docs/brain/recipes/pm-flow-data-sources.md)). PM data WRITES go through the [specs-table](docs/brain/libraries/specs-table.md) / goals-table SDK — never raw `.from('specs'|'spec_phases'|'goals'|'goal_milestones').update/insert/upsert/delete` (enforced by [scripts/_check-pm-sdk-compliance.ts](scripts/_check-pm-sdk-compliance.ts)). Derived status comes from the phase rollup; stored status columns are explicit lifecycle overrides only.
- **Internal joins use UUIDs**, never `shopify_*_id`. Shopify is being sunset.
- **All writes go through `createAdminClient()`** (service role). Never client-side.
- **Per-workspace credentials are encrypted** AES-256-GCM via `src/lib/crypto.ts`. Column names end with `_encrypted`.
- **AI responses are plain text, no markdown.** Max 2 sentences per paragraph. Mirror customer language.
- **User-facing names: `display_name` from `workspace_members`**, never full name.
- **Mini-site and live chat must produce identical ticket messages.** Only rendering differs.
- **`npx tsc --noEmit` before commits.** Migrations: `supabase/migrations/YYYYMMDDNNNNNN_description.sql`.
- **Portal builds:** after editing `shopify-extension/portal-src/`, run `node scripts/build-all-portals.js`.
- **Customer-referenced tables:** when adding a `customer_id` column, add a Sonnet data tool in `sonnet-orchestrator-v2.ts`.
- **Journeys + cancel-flow + remedies + coupon mappings:** all DB-driven, never hardcoded.
- **A director grades only the workers in its own charge.** Scoped by `ownerFunctionForKind(kind) === director.function`, enforced via `gradeableKindsForFunction` in [[docs/brain/libraries/agent-grader.md]]. A director never reaches across departments; a cross-function worker stays UNGRADED until its own director's sweep goes live. Same north-star principle as approval gates: a supervisor owns the layer below it, not adjacent departments. See [[docs/brain/operational-rules.md]] § North star.
- **One canonical org tree — no orphan tools.** Every worker, tool, agent-kind, cron, reactive fn, and inline agent resolves to exactly one `OwnerFunction` through [`src/lib/control-tower/node-registry.ts`](src/lib/control-tower/node-registry.ts) — the fusion of `MONITORED_LOOPS`, `personas.KIND_PERSONA_ALIAS`, and the `builder-worker.ts` job-kind union ([[docs/brain/libraries/control-tower-node-registry.md]]). `resolveNodeOwner(kind)` is the primary lookup; the historical `ORPHAN_OWNER='platform'` fallthrough is preserved as an audit hook (`resolveNodeOwnerOrOrphanDefault` bumps a `getOrphanSightings()` counter + `console.warn`s on a genuine miss, never silently defaults). Approval routing, grader owner-scoping, and the org-chart roster all read the SAME registry, so a cross-function worker's owner cannot diverge across surfaces. Add a node in the right source-of-truth file (MONITORED_LOOPS row / persona / `KIND_OWNER_FALLBACK`); `npm run check:node-registry-drift` catches any missed piece.
- **Monitor-cadence invariant: `MONITOR_TICK_FLOOR_MS` + 1.2× jitter grace.** Every `MONITORED_LOOPS` cron row's `expectedCadence` must be ≥ 5 min (the pinned monitor tick) AND `livenessWindowMs` ≥ `cadenceMs * 1.2` — enforced by `assertRegistryInvariants` in [`src/lib/control-tower/registry.ts`](src/lib/control-tower/registry.ts), which runs at module import and throws a line-numbered error naming the offender. Daily crons ⇒ **30h** windows, weekly ⇒ **9d**, monthly ⇒ **37d**. No sub-5-min crons (CEO 2026-07-11 monitoring-cost guardrail — widen the cadence or make it event-driven). See [[docs/brain/libraries/control-tower.md]] § `registry.ts`.

## Next.js note

This is Next.js 16 (App Router). APIs and conventions may differ from training data — read `node_modules/next/dist/docs/` before writing new patterns.
