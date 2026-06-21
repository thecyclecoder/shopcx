# Recipe: Querying the prod DB from the Developer Message Center

The DB-query convention for the [[../specs/developer-message-center|Developer Message Center]] (`kind='dev-ask'`). This page is **double duty**: a human reference **and** session context the runner injects each turn (the framing tells the box to Read it before any analytics question), so the box queries consistently every time. The house rule still holds: code without a brain page is incomplete — and the convention itself is documented here.

## The convention: throwaway query scripts, read-only, never committed

The Message Center is **report-back, never a builder**. The natural Claude shape for "how many storefront sessions had add-to-carts last week?" is:

1. Write a **throwaway `scripts/_*.ts`** in the per-thread worktree (the `_`-prefix marks a one-off; see [[../../.claude/skills/script-conventions|script-conventions]]).
2. Bootstrap the service-role client and run the SELECT / join / aggregation.
3. `npx tsx scripts/_your-query.ts`, read stdout, answer.
4. **Never commit it.** The worktree is recreated on `origin/main` each turn and torn down after; these scripts are scratch, not product code.

```ts
// scripts/_count-atc.ts  (THROWAWAY — never committed)
import { createAdminClient } from "../src/lib/supabase/admin";

async function main() {
  const db = createAdminClient();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const { count } = await db
    .from("storefront_sessions")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since)
    .eq("had_add_to_cart", true); // probe the real columns first — the DB is the spec
  console.log(`sessions w/ ATC in 7d: ${count}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
```

> The box has the **service-role key** (full creds, like [[../specs/box-ticket-improve]] / [[../specs/migration-fix-agent]]). The key *can* write — "read-only" is a **policy** enforced by the tool surface + the approval gate, **not** by the key. So the discipline below is load-bearing.

## Rules

- **SELECT-only from query scripts.** Never `insert`/`update`/`delete`/`upsert`/`rpc(<mutating>)` from a throwaway script. Reads are free and silent — never ask permission to query.
- **Probe before assuming** ([[../README#probing-technique]]). Confirm the table/column/enum shape (the database is the spec) before counting on it.
- **Internal joins use UUIDs**, never `shopify_*_id` (Shopify is being sunset).
- **Never commit.** No `git add`/`commit`; never edit `docs/brain/` or `src/`. A pure-investigation turn must leave `git status` clean.
- **Writes/migrations go through approval — always.** If the answer *requires* an INSERT/UPDATE/DELETE, **stop** and emit a `db_mutation` approval card (a self-contained `cmd` the worker runs on approval). A schema change (new table/column/migration) rides the **spec → build** handoff, never a `db_mutation`. The model never runs a mutation itself.

## "Does {feature} work right now?" investigations

Same read-only posture, wider sources: Read the code + the relevant brain page, then probe **recent Inngest runs / error rows read-only** (the relevant [[../tables/README|domain tables]]) and run `tsc`/grep in the worktree. Report what you found with file/line evidence — no mutation.

## When to use this

- Any analytics/state question in a `dev-ask` turn.
- Any "is this wired up / does it run" investigation.

## Gotchas

- `.env.local` is **absent on the box** — `createAdminClient()` reads the systemd-injected env. Don't depend on a local dotenv ([[../../.claude/skills/script-conventions|script-conventions]]).
- The worktree's `node_modules` is a **symlink** to the main clone — `npx tsx` works; don't `npm install`.
- Don't confuse a throwaway query script with a committed `apply-*-migration.ts`: the former is read-only scratch, the latter is a gated prod write authored via [[../../.claude/skills/write-migration|write-migration]] + run only on owner approval.

## Related

[[../specs/developer-message-center]] · [[../tables/dev_message_threads]] · [[../libraries/dev-message-threads]] · [[../tables/agent_jobs]] · [[../README#probing-technique]]
