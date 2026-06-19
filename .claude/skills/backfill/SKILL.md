---
name: backfill
description: Use to populate or correct a column/table across many existing rows in ShopCX — the genre of the 26 scripts/backfill-*.ts. Chunked, cursor-paginated, idempotent, resumable, two-phase (dry-run by default → --apply to write). Triggered by "backfill {column} for all {rows}" or a new column that needs historical values filled.
---

# backfill

Fill or fix a value across the whole back catalogue of rows, safely and resumably. A backfill is long-running and re-runnable: it must never double-apply, must survive a crash mid-run, and must show you what it'll do before it does it.

## Procedure

1. **Create** `scripts/backfill-{topic}.ts`. Use the standard bootstrap + `createAdminClient()` (see [[script-conventions]]). For big set-based SQL updates, a `pgClient()` against the pooler is fine too.
2. **Two-phase: dry-run by default.** Support a `--apply` flag. With no flag, **count + sample** the rows that *would* change and print the plan; mutate only when `--apply` is passed. (`const APPLY = process.argv.includes("--apply")`.)
3. **Select only the rows that still need it.** Filter on the unfilled state — `.is("col", null)` / `WHERE col IS NULL`. This is what makes the job **idempotent and resumable**: a re-run after a crash naturally skips already-done rows.
4. **Cursor-paginate, don't offset.** Supabase caps at ~1000 rows/request and `offset` drifts as you write. Page by a stable ordered key:
   ```ts
   let lastId: string | null = null;
   while (true) {
     let q = admin.from("t").select("id, …").is("col", null)
       .order("id", { ascending: true }).limit(1000);
     if (lastId) q = q.gt("id", lastId);
     const { data, error } = await q;
     if (error) throw error;
     if (!data?.length) break;
     // …process batch…
     lastId = data[data.length - 1].id;
     if (data.length < 1000) break;
   }
   ```
5. **Chunk the writes** (e.g. 1000 ids per `UPDATE … WHERE id IN (…)`) to avoid lock contention; for an external API source (Shopify/Appstle), add a small `await sleep(500)` between pages to respect rate limits.
6. **Log progress + a final tally.** `processed / total | updated | skipped | errors | elapsed` every N batches, then a `✓ DONE` summary line — this is your audit trail and your resume checkpoint.
7. **Run:** `npx tsx scripts/backfill-{topic}.ts` (review the plan) → `… --apply` (execute).

## Guardrails

- **Idempotent — always.** Re-running after a partial failure must not double-write. Achieve it by filtering on the unfilled state (step 3) and/or `INSERT … ON CONFLICT DO NOTHING`. Never `UPDATE` unconditionally.
- **Never run during active Inngest syncs** — a long backfill blocks the writes a sync needs, and a Vercel deploy will reap in-flight functions. Confirm syncs are drained first.
- **Bounded concurrency + retry** for big runs (a wave of ~15 with 2–3 retries and exponential backoff) — a single transient fetch error shouldn't kill a 20-minute job. See `scripts/backfill-events-customer-id.ts`.
- **Internal joins use UUIDs**, never `shopify_*_id`; all writes go through `createAdminClient()` (service role).
- A backfill is a real executed artifact (not a `_`-prefixed throwaway) — leave it in `scripts/` for the audit trail.
- **No prod creds under the box worker.** Author the script, then request approval to run the `--apply` pass: emit `{"status":"needs_approval","actions":[{"type":"run_prod_script","summary":"…","cmd":"npx tsx scripts/backfill-{topic}.ts --apply"}]}` and stop.

## Related
`scripts/backfill-events-customer-id.ts` · `scripts/backfill-returns.ts` · skills: `script-conventions`, `probe-db`, `write-migration`, `audit-reconcile` · `docs/brain/recipes/write-a-migration-apply-script.md` (§ Backfill apply scripts)
