# `src/lib/customer-situations.ts` — Customer-situations SDK

The single read/write chokepoint for [[../tables/product_customer_situations]] — the compliance-checked dataset of the real life-situations our customers were in, mined from the best-reviews set. ONE source shared by the AI shopping-agent MCP server (`find_products_for_situation`) and the PDP AI-answers (AEO) work. Phase 1 of the AI-shopping-agent build.

**Compliance invariant (north star):** incentivized/coupon reviews and disease/drug-term quotes are **stored** for audit but **never surfaced**. Every shopper-facing reader calls through this SDK with the default `compliantOnly=true`, which (1) returns only rows with `compliance_ok=true` AND `active=true` and (2) strips every nested quote whose own `compliance_ok` is not true, before the text can leave the server. A hand-rolled `.from('product_customer_situations')` bypasses that filter — forbidden outside this file and enforced by [scripts/_check-customer-situations-sdk-compliance.ts](../../../scripts/_check-customer-situations-sdk-compliance.ts) (wired into `predeploy`). See CLAUDE.md § Local conventions ("Raw `.from(...)` with no SDK → STOP"). Weight-loss results (pounds lost) are NOT a block reason since 2026-11-28 (CEO): a quote stored `compliance_ok=false` only for that is re-screened on read with `checkQuote` and surfaces with the results-may-vary note.

## Exports

| Export | Notes |
|---|---|
| `listSituations(admin, workspaceId, {productId?, compliantOnly=true, limit=200})` | → `CustomerSituationRow[]`. Optionally scoped to one product. **Default `compliantOnly=true`** returns only surfaceable rows with non-compliant quotes stripped (the safe shopper-facing path); pass `false` only for audit/admin tooling. Order `updated_at DESC`. |
| `getSituation(admin, workspaceId, productId, slug, {compliantOnly=true})` | → `CustomerSituationRow \| null`. Fetch one by the `(workspace, product, slug)` unique key. Default returns `null` for a non-compliant/inactive row and strips non-compliant quotes. |
| `upsertSituations(admin, workspaceId, rows)` | → `CustomerSituationRow[]`. Insert-or-update on `(workspace_id, product_id, slug)`. The sanctioned write path (seed backfill + any future author). Returns rows unfiltered — it's a writer, not a shopper-facing read. |

## Types

- `CustomerSituationRow` — a row of the table (see [[../tables/product_customer_situations]]).
- `SituationQuote` — `{ review_id, reviewer, rating, verified_purchase, featured, verbatim_phrase, compliance_ok, compliance_note? }`.
- `ListSituationsOptions` · `GetSituationOptions` · `UpsertSituationInput`.

`admin` is a `createAdminClient()` service-role client, passed in by the caller (same shape as the other chokepoints).

## Callers

- `scripts/_backfill-customer-situations.ts` — the idempotent ship-time seed from the Tabs situations fixture.
- [[situation-miner]] `applySituationMine` — the deterministic verify-and-screen gate that upserts mined situations from box sessions (Phase 2 / every advertised product).
- (Phase 2) the AI shopping-agent MCP server `find_products_for_situation` tool reads via `listSituations` (compliant-only).

## Related

[[../tables/product_customer_situations]] · [[product-intelligence]] · [[competitors]] (sibling chokepoint) · [[../lifecycles/product-intelligence]]
