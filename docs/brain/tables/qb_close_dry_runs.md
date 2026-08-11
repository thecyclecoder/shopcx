# qb_close_dry_runs

Append-only ledger of month-end close **dry runs** and their verdicts. The posting path refuses unless the latest row for a month has `passed`. Owner: [[../functions/cfo]] (Grace). Written by [[../libraries/qb-close-guard]] `recordDryRun`; read by `assertPostable`.

**Primary key:** `id` · **Lookup index:** `(workspace_id, closing_month, ran_at desc)` · **No unique key — append-only by design.**

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `closing_month` | `text` | NOT NULL · `'YYYY-MM'` |
| `ran_at` | `timestamptz` | NOT NULL · default `now()` |
| `passed` | `boolean` | NOT NULL · **computed by `assessDryRun`, never set by hand** |
| `blocking_issues` | `jsonb` | `[{code, detail}]` — empty iff `passed` |
| `warnings` | `jsonb` | non-blocking observations |
| `je_balanced` | `boolean?` | \|debits − credits\| ≤ $0.01 |
| `je_total_debits` / `je_total_credits` | `numeric?` | |
| `je_line_count` | `int?` | |
| `adjustment_line_count` | `int?` | |
| `adjustment_abs_units` | `int?` | Σ \|QtyDiff\| |
| `adjustment_value` | `numeric?` | Σ \|QtyDiff\| × `unit_cost` — what the plausibility band watches |
| `receipt_units` | `jsonb?` | `{amazon, shopify, internal}` |
| `input_health` | `jsonb?` | opening-book rows · processors present · receipts-lookup-ok · snapshot dates · order count |
| `created_at` | `timestamptz` | |

## Why a ledger rather than a boolean

The July 2026 dry run needed **six passes** before it was trustworthy ($85,864 → $2,364), each pass changing a different input. Keeping every attempt makes "what did we know when we posted?" answerable after the fact, and makes a regression between two dry runs visible instead of silently overwritten.

## Common queries

```ts
// latest verdict for a month (what the guard reads)
const { data } = await admin
  .from("qb_close_dry_runs")
  .select("passed, ran_at, blocking_issues")
  .eq("workspace_id", ws).eq("closing_month", "2026-07")
  .order("ran_at", { ascending: false }).limit(1).maybeSingle();
```

```ts
// how the adjustment moved across attempts — the shape of an investigation
const { data } = await admin
  .from("qb_close_dry_runs")
  .select("ran_at, passed, adjustment_value, blocking_issues")
  .eq("workspace_id", ws).eq("closing_month", "2026-07")
  .order("ran_at");
```

## Gotchas

- **`passed` is not "the numbers are right"** — it is "no known blocker fired." The guard grades what it is given; a present-but-wrong input still passes. Column-selection correctness lives in [[../libraries/qb-close-month-end]].
- Never UPDATE a row. A re-run inserts.
- `input_health.receipts_lookup_ok = true` with `received_items = 0` is a legitimate "nothing received this month". `false` means the query broke and the term is unverified — a very different thing, and the distinction the whole table exists to preserve.

## Related

[[qb_month_end_closings]] · [[../libraries/qb-close-guard]] · [[../libraries/qb-close-month-end]] · [[../lifecycles/shoptics-migration]]
