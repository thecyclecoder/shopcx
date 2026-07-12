# function_autonomy

The per-function **`live + autonomous` flag** — the progressive-offload switch behind the org-chart approval router ([[../specs/approval-routing-engine]] Phase 1). One row per `docs/brain/functions/{slug}.md` director.

[[../libraries/approval-router]] `resolveApprover` walks **up** the org chart from a raising tool's owner function to the first ancestor that is **both** `live` (its director-agent is running) **and** `autonomous` (trusted to auto-decide); if none qualifies, it falls through to the **CEO** — the fail-safe root. This table is the *only* state that flips a function from "routes to CEO" to "auto-approves here."

**Seeded ALL-OFF** (fail-safe: an unconfigured / partially-configured org never silently auto-approves — every approval routes to the one CEO inbox until a function is explicitly flipped on). **Current state:** `platform` is `live=true, autonomous=true` since **2026-06-23 20:35** (`updated_by=ceo`) — the first function automated; **`growth` is `live=true, autonomous=true` since 2026-06-30 15:44 UTC** (`updated_by=ceo`, via [[../specs/growth-director-live-autonomous-cutover]] `scripts/apply-growth-live-autonomous.ts`). So platform-owned approvals route to the Platform/DevOps Director (Ada) and growth-owned approvals to the Growth Director; the other directors remain off. The workspace owner toggles a function on from the [[../dashboard/agents|Agents hub]] (`POST /api/developer/agents/autonomy`).

**CS Director seat scaffolded 2026-09-17** ([[../specs/cs-director-persona-and-org-placement]] Phase 2, via `scripts/apply-cs-director-seat.ts` → migration `20260917120000_cs_director_function_autonomy_seed.sql`). The `cs` row remains at `(live=false, autonomous=false)` — the safest leash / "dormant" — so the router still falls through to the CEO for every CS-owned approval; only the audit trail (`updated_by='cs-director M5 scaffold — safest leash'`) is stamped. The seat exists for the M5 activation switch: when the CEO flips `cs` live+autonomous from the Agents hub, the CS Director agent (persona 💬 **June** — see [[../libraries/cs-director]]) starts auto-deciding routed CS approvals within its leash. Read-only verification: `npx tsx scripts/_verify-cs-director-seat.ts` prints the row + current leash. The scaffold migration is **compare-and-set** — it only re-stamps the audit note when the row is still at `(false, false)`; it never demotes an already-activated director.

**GLOBAL config — not workspace-scoped.** The org chart is ShopCX's own internal DevOps org, singular, so there is no `workspace_id`; `function_slug` is the PK. Read + written via the service role ([[../libraries/approval-router]] `loadAutonomyMap` + the autonomy API); the toggle API is **owner-gated** above the DB. RLS: any authenticated user reads (the hub gates in the route); service role does writes.

**Primary key:** `function_slug`

## Columns

| Column | Type | Notes |
|---|---|---|
| `function_slug` | `text` | PK · the function slug — matches `docs/brain/functions/{slug}.md` (e.g. `platform`, `growth`). The CEO is the **implicit root**, never a row here. |
| `live` | `boolean` | the director-agent is running (M4). Necessary-but-not-sufficient for auto-approval · default `false` |
| `autonomous` | `boolean` | the director is trusted to auto-decide. `live && autonomous` ⇒ this function is an **auto-approver** · default `false` |
| `updated_by` | `text?` | the `workspace_members.display_name` (or system actor) that last flipped a flag — audit trail |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Invariants

- **`autonomous` implies `live`.** An offline director can't auto-approve. The toggle API clears `autonomous` whenever `live` is turned off (`if (!live) autonomous = false`).
- **Missing row ⇒ off.** A brand-new `functions/*.md` director with no row is treated as off by the router (`loadAutonomyMap` returns no key ⇒ `isAutoApprover` is false), so the seed is a convenience for the toggle UI, not a correctness dependency — **fail-safe by default.**
- **CEO is never a row.** The CEO is the router's fallback root; it has no `function_autonomy` entry.

## Readers / writers

- **`loadAutonomyMap()`** ([[../libraries/approval-router]]) — `select function_slug, live, autonomous` → `AutonomyMap`. Error/empty ⇒ `{}` (all off). Read by `resolveApprover*` and by [[../dashboard/agents|org-chart.ts]] `getOrgChart` to derive each director's `offline ｜ live ｜ autonomous` status badge.
- **`POST /api/developer/agents/autonomy`** (`src/app/api/developer/agents/autonomy/route.ts`) — owner-gated upsert (`onConflict: function_slug`). Partial toggles preserve the other flag; rejects unknown slugs (must be a real `functions/*.md` function).

## Migration

`supabase/migrations/20260701120000_function_autonomy.sql` (apply: `npx tsx scripts/apply-function-autonomy-migration.ts`). Idempotent — `create table if not exists` + seed `on conflict do nothing` for the five functions (`growth`, `cmo`, `retention`, `cs`, `platform`).

## Related

[[../specs/approval-routing-engine]] · [[../libraries/approval-router]] · [[../libraries/control-tower-node-registry]] — the canonical org tree the approval walk starts from: `resolveApprover(resolveNodeOwner(kind), chart, autonomy)` is the north-star cascade. The registry picks the OWNER; this table's `live+autonomous` flag decides whether that owner AUTO-DECIDES or falls through to the CEO · [[../specs/control-tower-canonical-node-registry]] · [[../dashboard/agents]] · [[../functions/platform]] · [[../goals/devops-director]] · [[../operational-rules]] (§ North star — supervisable autonomy)
