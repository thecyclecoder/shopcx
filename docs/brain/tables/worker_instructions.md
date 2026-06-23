# worker_instructions

The per-worker **mutable, versioned instruction store** — guidance the [[../specs/platform-director-agent|DevOps Director]] writes to **teach a worker**, appended to that worker's base prompt **at runtime, every run** ([[../specs/worker-coaching-loop]], Phase 1). This is what makes **coaching a data write, not a deploy**: when the director spots a worker making the same class of mistake N times, it writes a new ACTIVE learning here, and the worker picks it up on its very next run with no code change.

Mirrors the [[grader_prompts]] versioned-calibration shape + the [[../specs/storefront-lever-importance-memory|lever-importance memory]] (a learned store loaded into a prompt at runtime). Written/loaded via [[../libraries/worker-instructions]]; coached by the director via [[../libraries/worker-coaching]].

**Director-gated write path** (north-star CEO → director → worker): `coached_by` is the **supervising director's** function slug — never the worker. RLS is **service-role-write-only**, so a worker (a read-only `claude -p` box session) has no path to edit its own instructions. Every amendment is **reversible** (status → `reverted`) and **versioned** (a newer coaching supersedes the prior for the same `error_class`).

**Workspace-scoped** (mirrors [[director_activity]]). RLS: any authenticated user reads; service role does all writes.

**Migration:** `supabase/migrations/20260703120000_worker_coaching.sql` · apply via `npx tsx scripts/apply-worker-coaching-migration.ts`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `worker_kind` | `text` | the [[agent_jobs]] kind that identifies the worker (e.g. `repair`, `regression`) |
| `error_class` | `text` | the class of mistake the guidance addresses — the **supersede/dedup key** within a worker (e.g. `foreign`) |
| `guidance` | `text` | the learning: "when you see X, do Y instead" (appended to the worker's prompt) |
| `triggering_pattern` | `text` | the human-readable repeated mistake that prompted it · default `''` |
| `reasoning` | `text` | the "why" (the Z) · default `''` |
| `status` | `text` | `active｜superseded｜reverted` — **open vocabulary, no CHECK**. Only `active` is loaded · default `active` |
| `version` | `int` | bumps per supersede within `(worker_kind, error_class)` · default `1` |
| `supersedes_id` | `uuid` | FK → `worker_instructions(id)` — the prior version this replaced (null on the first) |
| `coached_by` | `text` | the **supervising director's** function slug (the gate; never the worker) |
| `source_grade_id` | `uuid` | the [[../specs/director-loop-grading|director_decision_grade]] that prompted it (null until that store exists) |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` |

## Indexes

- `worker_instructions_load_idx` on `(workspace_id, worker_kind, status, created_at desc)` — the runtime load (active guidance, newest-first).
- `worker_instructions_class_idx` on `(worker_kind, error_class)` — supersede/dedup by class.

## Common queries

### The runtime load — a worker's active guidance (appended to its prompt)
```ts
const { data } = await admin.from("worker_instructions")
  .select("guidance, reasoning, error_class")
  .eq("workspace_id", workspaceId).eq("worker_kind", "repair").eq("status", "active")
  .order("created_at", { ascending: false });
```

## Gotchas

- Only `status='active'` rows are loaded into a worker's prompt — a `superseded`/`reverted` row is history, not guidance.
- The write path is **director-gated** at the library (`coachWorker` requires `coachedBy`) AND at RLS (service-role only). Don't add a client write path.

## Related

[[../libraries/worker-instructions]] · [[../libraries/worker-coaching]] · [[worker_coaching_log]] · [[../specs/worker-coaching-loop]] · [[grader_prompts]] · [[../specs/storefront-lever-importance-memory]] · [[../goals/devops-director]]
