# libraries/ticket-directions

Server SDK for the durable **Direction artifact** Sol writes ONCE per ticket on the first-touch box session ([[../tables/ticket_directions]] · [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]]). Backs the one-live-row invariant enforced by the DB-level partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL`. All writes go through a service-role client passed in by the caller (`createAdminClient()` in the worker — per CLAUDE.md's "All writes go through createAdminClient()").

**File:** `src/lib/ticket-directions.ts`

## Types

- `TicketDirectionPath = "playbook" | "stateless" | "needs_info"` — the three treatment paths Sol can commit the ticket to on first touch. `playbook` drives an existing playbook; `stateless` is a single stateless reply; `needs_info` asks the customer for a specific missing piece before any action.
- `TicketDirection` — the full row: `{ id, workspace_id, ticket_id, intent, context_summary, chosen_path, plan, guardrails, authored_by, authored_at, superseded_at }`. `plan` + `guardrails` are `Record<string, unknown>` (path-specific shapes; see the spec).

## Exports

### `writeDirection` — function

```ts
async function writeDirection(
  admin: Admin,
  input: {
    workspace_id: string;
    ticket_id: string;
    intent: string;
    context_summary: string;
    chosen_path: TicketDirectionPath;
    plan?: Record<string, unknown>;
    guardrails?: Record<string, unknown>;
    authored_by?: string;
  },
): Promise<TicketDirection>
```

Inserts one LIVE Direction (`superseded_at IS NULL`) for a ticket. The DB-level partial UNIQUE guarantees exactly one live row per ticket — a concurrent second `writeDirection` on the same ticket errors here with `23505 unique_violation` (Postgres). Callers re-authoring a Direction MUST call `superseDirection` first. Default `authored_by` = `'sol_box_session'` (the spec's Phase 3 verification bullet asserts this value on Sol-written rows).

**Called by:** `runTicketHandleJob` in [[../../scripts/builder-worker]] — after parsing Sol's final JSON and re-asserting the required-field invariant (learning #1 — the write is guarded on `intent`/`context_summary`/`chosen_path ∈ {playbook, stateless, needs_info}` before firing).

### `superseDirection` — function

```ts
async function superseDirection(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketDirection | null>
```

Compare-and-set on the live row: stamps `superseded_at = now()` on the single row where `ticket_id = ? AND superseded_at IS NULL` (and optionally `workspace_id = ?` to defend a cross-workspace ticket-id collision). Returns the superseded row, OR `null` when there was no live row (or another caller won the race — the compare-and-set on `superseded_at IS NULL` guarantees a stale stamp can't overwrite a fresh one).

**Called by:** future inflection handling (Phase 3 lands the dispatcher; a later spec wires the rare-inflection path — customer pivot / guardrail rail-hit — that calls `superseDirection` + a fresh `writeDirection`).

### `getLiveDirection` — function

```ts
async function getLiveDirection(
  admin: Admin,
  ticket_id: string,
  opts?: { workspace_id?: string },
): Promise<TicketDirection | null>
```

Reads the live Direction for a ticket (`superseded_at IS NULL`), or `null` when Sol hasn't authored one yet. Uses `maybeSingle()` under the partial-UNIQUE invariant, so a corrupted state (two live rows) would surface as a query error rather than silently returning one. Optional `workspace_id` scope guards cross-workspace collisions.

**Called by:** future cheap-execution dispatchers (Phase 3 lands the unified-ticket-handler branch that calls `getLiveDirection` and drives off `chosen_path` + `plan` + `guardrails` instead of re-running the full-context orchestrator prompt).

## Invariants

- **One live row per ticket.** Enforced by the DB partial UNIQUE `(ticket_id) WHERE superseded_at IS NULL` — the SDK does NOT re-check in application code (a select-then-insert race defeats that; the DB is the authority). A `writeDirection` failure with `23505` = a live row already exists.
- **Directions are authored, never mutated.** Only `superseDirection` ever changes a row's `superseded_at`; no export mutates `intent` / `plan` / `guardrails` in place.
- **Compare-and-set on supersede.** `superseDirection`'s write is `.eq("ticket_id", …).is("superseded_at", null)` — a racing supersede returns zero rows and the caller sees `null` (learning #1 — re-assert the read-time precondition in the write itself).
- **Service-role only.** Every export takes `admin: SupabaseClient` — RLS is on with no policies, so a non-service-role read/write is rejected at the DB. Never call from client code.

---

[[../README]] · [[../tables/ticket_directions]] · [[../specs/sol-ticket-direction-artifact-and-first-touch-box-session]] · [[../goals/sol-ticket-direction-then-cheap-execution]] · [[../functions/cs]] · [[../../CLAUDE]]
