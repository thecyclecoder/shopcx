# DB Health Agent — watch tables for growth / slow queries / missing indexes, propose fixes ⏳

**Owner:** [[../functions/platform]] · **Parent:** a new self-watching agent for [[control-tower]] (a DB-health domain); mirrors [[repair-agent]] (propose-don't-auto-apply) + [[control-tower-migration-drift-check]] (box-side DB introspection). · **Commissioned 2026-06-23** after the `loop_heartbeats` flood (21.7M rows / 4.5 GB from a runaway 175/sec writer) silently blinded the Control Tower — exactly the class of problem a DB agent catches *early*. That incident is its canonical first catch.

A standing agent that watches Postgres health and **proposes** fixes (retention, indexes, query rewrites, vacuum) — it never silently applies DDL or deletes (a bad index slows writes; a retention delete loses data — higher-stakes autonomy, owner-gated, per the [[../operational-rules]] § North star). It's a tool optimizing a bounded proxy (DB perf/size), supervised by Platform.

## What it monitors (box-side, reads `pg_stat_*` via the pooler — like migration-drift)
- **Runaway / unbounded growth.** Per-table row count + `pg_total_relation_size`, snapshotted daily into a small `db_table_size_history` so it can compute a **growth rate**. Flags a table growing fast or with no apparent retention (append-only, oldest row keeps receding) — *the `loop_heartbeats` 21.7M case*. Also flags an abnormal **write rate** to one `loop_id`/key (the 175/sec feed-flood signal) where applicable.
- **Slow / expensive queries — surfaced FREQUENTLY + root-caused (owner emphasis 2026-06-23).** A **frequent** pass (e.g. hourly, separate from the daily size sweep) reads `pg_stat_statements` (confirmed installed) — top by `mean_exec_time` + `total_exec_time` × `calls` + `stddev` (erratic plans), correlated with `57014` statement-timeouts in the error feed. For each top offender it doesn't just *report* it — it **diagnoses WHY**: run `EXPLAIN` (and `EXPLAIN (ANALYZE, BUFFERS)` only on safe SELECTs, never on writes) on the query and classify the cause — **Seq Scan on a big table** (missing/wrong index → the index it'd add), **no/poor index match on the join or WHERE predicate**, **a sort/hash spilling to disk** (work_mem / index-for-order-by), **a full-table aggregate / `distinct` scan** (the `control_tower_loop_beats` class — drive the set from a small list instead), **missing `LIMIT`**, or **bloat/stale stats** (needs vacuum/analyze). The proposed fix maps to the diagnosed cause, with the EXPLAIN evidence cited in the spec.
- **Missing indexes.** `pg_stat_user_tables`: a large table with high `seq_scan` vs `idx_scan` (lots of full scans) → propose an index (inferred from the slow query's predicate). 
- **Unused / redundant indexes.** `pg_stat_user_indexes` `idx_scan = 0` on a large table → propose dropping it (write overhead + bloat).
- **Bloat / vacuum lag.** Dead-tuple ratio + `last_autovacuum`; propose a VACUUM/tuning when a hot table is bloated.

## What it proposes (surface-don't-apply, like the repair agent)
- On a finding, it **authors a single-phase fix spec** (`docs/brain/specs/{slug}.md`, owner platform) — a **retention cron** (the loop_heartbeats fix), an **index** (`CREATE INDEX CONCURRENTLY` so no write lock), a **query rewrite**, an **index drop**, or a **VACUUM/tuning** — and **surfaces it for one-tap owner Build** (`needs_approval`, the repair-agent pattern). It does **NOT** run DDL / deletes itself.
- **Dedupe + rank.** One open proposal per finding-signature (no flooding — mirror [[repair-agent-dedup]]); rank by impact (table size × seq-scan share; query total_time). Never propose an index that already exists, or retention for a table that already has it.

## North star + surface
- Registered as a **monitored loop** + a **DB Health panel** in the Control Tower (top tables by size/growth, slowest queries, proposed fixes) — so a dead DB agent is itself visible, and the owner sees the reasoning behind every proposal.
- Owner approves the fix → it builds through the normal pipeline. Nothing touches the schema/data without that tap.

## Verification
- Seed a table growing unbounded (or point at a known one) → the agent flags it + authors a **retention-cron** fix spec surfaced for Build (would have caught loop_heartbeats).
- The frequent slow-query pass picks a top `pg_stat_statements` offender, runs `EXPLAIN` on it, and the proposed fix **names the diagnosed cause** (e.g. "Seq Scan on `X` (N rows) in the WHERE on `col` → add `idx X(col)`") with the plan quoted — not just "this query is slow." Approving the index build drops the query's mean time + seq-scan share on the next pass.
- An `idx_scan=0` index on a large table → a **drop-index** proposal.
- Re-run with a finding already proposed → **no duplicate** spec (signature-deduped). A table that already has retention / the index → **not** flagged.
- The agent is a green monitored loop with a DB Health panel; a dead agent shows red. It applies **zero** DDL/deletes on its own.

## Phase 1 — the monitor (frequent slow-query root-cause + daily growth) + propose fix specs ⏳
Box-side jobs on two cadences: a **frequent (~hourly) slow-query pass** that reads `pg_stat_statements`, runs `EXPLAIN` on each top offender, classifies the cause, and proposes the matching fix; a **daily sweep** for size/growth (`pg_class` + a `db_table_size_history` snapshot), `pg_stat_user_tables`/`_indexes` (missing/unused index), and bloat. Both author + surface deduped fix specs (retention/index/rewrite/drop/vacuum) for owner Build; register the monitored loop(s) + DB Health panel. Brain: [[repair-agent]] · [[control-tower-migration-drift-check]] · [[../libraries/control-tower]] · [[control-tower]] · [[loop-heartbeats-retention]] · [[../recipes/write-a-migration-apply-script]].

## Phase 2 — growth-trend alerting + bloat/vacuum proposals ⏳
Use the size-history to alert on a *trend* (projected to hit a threshold in N days, not just current size) + bloat/autovacuum-lag proposals. Brain: [[control-tower]] · [[../libraries/control-tower]].
