# lander_content_gaps

One row per real-evidence asset slot Carrie's `dr-content` box lane cannot ethically generate (before/after transformation, UGC selfie, testimonial photo, press/certification logo). Carrie NEVER fabricates a customer result — the never-fake-a-customer-result line — so when a [[lander_blueprints]] block calls for real evidence and no matching [[product_media]] row exists, she opens a gap row here for the founder to supply. See [[../specs/carrie-dr-content]] · [[../functions/growth]].

**North-star (supervisable autonomy):** Carrie's leash is COPY + GENERATED illustration; every real-evidence slot escalates to a human. The gap is the escalation channel — surfaced through [[../libraries/approval-inbox]] (`ownerFunctionForKind('dr-content') = 'growth'`, routed to Max).

**Design:** a lifecycle appendix to [[lander_blueprints]]. `ON DELETE CASCADE` — purging a blueprint takes its gaps with it (they're never standalone work).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `blueprint_id` | `uuid` | — | → [[lander_blueprints]].id · ON DELETE CASCADE. The blueprint this gap belongs to. |
| `asset_role` | `text` | — | CHECK ∈ `before_after` \| `ugc` \| `testimonial_photo` \| `press_logo` \| `other`. The persuasive job of the missing asset — must be one Carrie would NEVER ethically generate. |
| `block_ref` | `text` | — | Which skeleton block on the blueprint needs this asset (matches [[lander_blueprints]] `skeleton.blocks[].role` — e.g. `hero`, `reason_1`, `faq`). Free-text. |
| `description` | `text` | — | Plain-language description written for the FOUNDER — "please supply a 3-photo before/after story from a customer who lost 15+lb on the coffee." No jargon, no lever names. |
| `status` | `text` | — | default `'open'` · CHECK ∈ `open` \| `resolved`. |
| `resolved_media_id` | `uuid` | ✓ | → [[product_media]].id · ON DELETE SET NULL. The [[product_media]] row the resolution landed on. Nullable while open; populated on resolve. |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()`, auto-bumped by `lander_content_gaps_touch_updated_at` on any UPDATE. |

**Indexes:** `(blueprint_id, status)` — Carrie's "any open gaps left on this blueprint?" probe (drives the blueprint-status transition: `awaiting_upload` while any open gap remains, `content_complete` when zero) · `(workspace_id, status)` — Max's inbox open-gap queue.

## Lifecycle (`status`)

| Status | Meaning |
|---|---|
| `open` | Waiting on the founder to upload / supply the asset. Surfaced to Max via [[../libraries/approval-inbox]]. |
| `resolved` | The founder uploaded; `resolved_media_id` points at the resolved [[product_media]] row. |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id` (CASCADE)
- `blueprint_id` → [[lander_blueprints]].`id` (CASCADE)
- `resolved_media_id` → [[product_media]].`id` (SET NULL)

**In (others → this):**

_None._

## Common queries

### Open gaps for one blueprint (Carrie's status-transition probe)
```ts
import { listContentGaps } from "@/lib/lander-blueprints";
const open = await listContentGaps(workspaceId, { blueprint_id, status: "open" });
// zero open → setBlueprintStatus(workspaceId, blueprint_id, "content_complete")
// else       → setBlueprintStatus(workspaceId, blueprint_id, "awaiting_upload")
```

### Max's inbox — every open gap in the workspace
```ts
import { listContentGaps } from "@/lib/lander-blueprints";
const inbox = await listContentGaps(workspaceId, { status: "open" });
```

### Resolve a gap after the founder uploads
```ts
import { resolveContentGap } from "@/lib/lander-blueprints";
await resolveContentGap(workspaceId, gapId, resolvedProductMediaId);
```

## RLS

- `lander_content_gaps_select` — `authenticated` read where `workspace_id` ∈ caller's [[workspace_members]].
- `lander_content_gaps_service` — `service_role` full. All writes go through `createAdminClient()` via [[../libraries/lander-blueprints]].

## Gotchas

- **`asset_role` is restricted to real-evidence categories.** A generatable slot (`lifestyle`, `ingredient`, `mechanism`, `hero`) NEVER opens a gap — Carrie generates it via [[../libraries/gemini]] and writes a [[product_media]] row with `source='generated'` instead. If you're tempted to open a gap for a generatable slot, that's a persuasive-job classification mistake upstream in [[../specs/carrie-dr-content]] Phase 2.
- **All writes go through [[../libraries/lander-blueprints]].** `openContentGap` / `resolveContentGap` / `listContentGaps` — no raw `.from('lander_content_gaps').insert|update|upsert` outside the SDK. Same chokepoint discipline as [[lander_blueprints]] / [[research_urls]] / [[specs-table]] / goals-table.
- **Purging a blueprint deletes its gaps (CASCADE).** By design — gaps are a lifecycle appendix, not standalone work. If you need audit history, snapshot before purging.
- **`resolved_media_id` SET NULL, not CASCADE.** A purged [[product_media]] row leaves the gap-history in place (audit trail — "we resolved this once, the row got purged later"). If it went to zero open gaps at that moment the blueprint stayed `content_complete`; the historical resolution is intentionally not re-opened.
- **`description` is written for the FOUNDER.** No jargon, no lever names, no block role IDs. If a founder can't read the description and know what to shoot / supply, the gap is malformed.

## Written by

[[../libraries/lander-blueprints]] (`openContentGap`, `resolveContentGap`) ← Carrie's `dr-content` [[agent_jobs]] worker (Phase 2 — opens a gap per real-evidence slot when [[product_media]] has no matching row) + owner-facing resolution UI (Phase 3).

## Read by

[[../libraries/lander-blueprints]] (`listContentGaps`) ← Carrie's `dr-content` worker (status-transition probe) + [[../libraries/approval-inbox]] (Max's `dr-content` inbox lane).

## Related

[[../specs/carrie-dr-content]] · [[../specs/cleo-lander-blueprint]] · [[../goals/acquisition-research-engine]] · [[lander_blueprints]] · [[product_media]] · [[agent_jobs]] · [[../functions/growth]] · [[../libraries/lander-blueprints]] · [[../libraries/approval-inbox]] · [[../libraries/gemini]]

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
