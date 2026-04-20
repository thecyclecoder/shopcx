# Customer Demographic Inference — Implementation Spec

## Overview

Infer demographic attributes from existing customer data — name, zip code (Census API), and order history — to auto-populate the Product Intelligence Engine's `target_customer` field and enable segmentation. Three enrichment tracks run in parallel: Claude Haiku for name→gender/age, US Census Bureau API for zip→income/education/urban, and local logic for order history→buyer type/health priorities.

This spec is self-contained. A developer should be able to implement it from a worktree without asking questions.

---

## 1. Database Migrations

File: `supabase/migrations/20260420000002_customer_demographics.sql`

### 1a. `zip_code_demographics` (Census cache)

```sql
CREATE TABLE public.zip_code_demographics (
  zip_code TEXT PRIMARY KEY,
  median_income INTEGER,
  median_age NUMERIC,
  owner_pct NUMERIC,
  college_pct NUMERIC,
  population INTEGER,
  population_density NUMERIC,
  urban_classification TEXT CHECK (urban_classification IN ('urban', 'suburban', 'rural')),
  income_bracket TEXT CHECK (income_bracket IN (
    'under_40k', '40-60k', '60-80k', '80-100k', '100-125k', '125-150k', '150k+'
  )),
  state TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acs_year INTEGER
);

-- No RLS needed — this is public Census data, not workspace-scoped
```

### 1b. `customer_demographics`

```sql
CREATE TABLE public.customer_demographics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- Name inference (Claude Haiku)
  inferred_gender TEXT CHECK (inferred_gender IN ('female', 'male', 'unknown')),
  inferred_gender_conf NUMERIC CHECK (inferred_gender_conf >= 0 AND inferred_gender_conf <= 1),
  inferred_age_range TEXT CHECK (inferred_age_range IN (
    'under_25', '25-34', '35-44', '45-54', '55-64', '65+'
  )),
  inferred_age_conf NUMERIC CHECK (inferred_age_conf >= 0 AND inferred_age_conf <= 1),
  name_inference_notes TEXT,

  -- Zip code enrichment (Census API)
  zip_code TEXT,
  zip_median_income INTEGER,
  zip_median_age NUMERIC,
  zip_income_bracket TEXT CHECK (zip_income_bracket IN (
    'under_40k', '40-60k', '60-80k', '80-100k', '100-125k', '125-150k', '150k+'
  )),
  zip_urban_classification TEXT CHECK (zip_urban_classification IN ('urban', 'suburban', 'rural')),
  zip_owner_pct NUMERIC,
  zip_college_pct NUMERIC,

  -- Order history analysis (local logic)
  inferred_life_stage TEXT CHECK (inferred_life_stage IN (
    'young_adult', 'family', 'empty_nester', 'retirement_age', 'unknown'
  )),
  health_priorities TEXT[] DEFAULT '{}',
  buyer_type TEXT CHECK (buyer_type IN (
    'value_buyer', 'cautious_buyer', 'committed_subscriber',
    'new_subscriber', 'lapsed_subscriber', 'one_time_buyer'
  )),
  total_orders INTEGER DEFAULT 0,
  total_spend_cents INTEGER DEFAULT 0,
  subscription_tenure_days INTEGER DEFAULT 0,

  -- Metadata
  enriched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enrichment_version INTEGER NOT NULL DEFAULT 1,
  census_data_year INTEGER,

  UNIQUE(customer_id)
);

CREATE INDEX idx_customer_demographics_workspace ON public.customer_demographics(workspace_id);
CREATE INDEX idx_customer_demographics_gender ON public.customer_demographics(inferred_gender);
CREATE INDEX idx_customer_demographics_age ON public.customer_demographics(inferred_age_range);
CREATE INDEX idx_customer_demographics_income ON public.customer_demographics(zip_income_bracket);
CREATE INDEX idx_customer_demographics_buyer ON public.customer_demographics(buyer_type);

ALTER TABLE public.customer_demographics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read customer_demographics" ON public.customer_demographics
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on customer_demographics" ON public.customer_demographics
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

### 1c. Add `census_api_key` to workspaces

```sql
ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS census_api_key_encrypted TEXT;
```

---

## 2. Settings — Census API Integration Card

### Location

Add a card to `/dashboard/settings/integrations` (or wherever the existing integration cards live — Klaviyo, Appstle, etc.).

### Card UI

**Title:** US Census Bureau
**Description:** Enrich customer demographics with zip code data — median income, education, urban/rural classification. Free API, no cost.
**Fields:**
- API Key (password input, optional but recommended for production)
  - Helper text: "Get a free key at api.census.gov/data/key_signup.html — optional but recommended"
- Status badge: "Connected" (green) if key is set, "No key (limited)" (amber) if empty — Census API works without a key but has lower rate limits

**Save** encrypts the key via `encrypt()` from `src/lib/crypto.ts` and stores in `workspaces.census_api_key_encrypted`.

### API Route

**`PATCH /api/workspaces/[id]/settings/census`**

```typescript
// Request
{ api_key: string }
// Response
{ success: true }
```

Encrypts and stores. Standard admin/owner auth check.

**`GET /api/workspaces/[id]/settings/census`**

```typescript
// Response
{ has_key: boolean }
```

Never return the actual key.

---

## 3. Census API Client

File: `src/lib/census.ts`

### Core Function

```typescript
export async function fetchZipDemographics(
  zip: string,
  apiKey?: string,
): Promise<ZipDemographics | null>
```

**Logic:**
1. Check `zip_code_demographics` table for cached entry. If exists and `fetched_at` is within 1 year, return cached.
2. Call Census API:
   ```
   https://api.census.gov/data/2022/acs/acs5
     ?get=B19013_001E,B01002_001E,B25003_001E,B25003_002E,B15003_001E,B15003_022E,B01003_001E
     &for=zip%20code%20tabulation%20area:{zip}
     &key={apiKey}  // omit param entirely if no key
   ```
3. Parse response. Handle `-666666666` (Census suppressed data) as null.
4. Calculate derived fields:
   - `owner_pct = B25003_002E / B25003_001E`
   - `college_pct = B15003_022E / B15003_001E`
   - `income_bracket` from `median_income` using bracket function
   - `urban_classification` from population: >50K urban, >10K suburban, else rural
5. Upsert into `zip_code_demographics` cache.
6. Return result.

### Census Variables Reference

| Variable | Description |
|---|---|
| `B19013_001E` | Median household income |
| `B01002_001E` | Median age |
| `B25003_001E` | Total occupied housing units |
| `B25003_002E` | Owner-occupied housing units |
| `B15003_001E` | Total population 25+ (education denominator) |
| `B15003_022E` | Bachelor's degree holders |
| `B01003_001E` | Total population |

### Helper Functions

```typescript
export function incomeToBracket(income: number): string
export function classifyUrban(population: number): 'urban' | 'suburban' | 'rural'
```

### Type

```typescript
export interface ZipDemographics {
  zip_code: string;
  median_income: number | null;
  median_age: number | null;
  owner_pct: number | null;
  college_pct: number | null;
  population: number | null;
  population_density: number | null;
  urban_classification: 'urban' | 'suburban' | 'rural' | null;
  income_bracket: string | null;
  state: string | null;
  acs_year: number;
}
```

---

## 4. Order History Analyzer

File: `src/lib/customer-demographics.ts`

### Function

```typescript
export function analyzeOrderHistory(
  orders: { total_cents: number; created_at: string; source_name?: string; line_items: { title?: string; sku?: string; quantity?: number }[] }[],
  subscriptions: { status: string; created_at: string; items: unknown[] }[],
): OrderDemographics
```

**Pure logic, no AI, no external calls.**

### Buyer Type Logic

| Condition | Type |
|---|---|
| Active sub with tenure > 180 days | `committed_subscriber` |
| Active sub with tenure <= 180 days | `new_subscriber` |
| Had sub, now cancelled, no active | `lapsed_subscriber` |
| No sub, 1 order only | `one_time_buyer` |
| No sub, >60% orders are 3+ quantity | `value_buyer` |
| Everything else | `cautious_buyer` |

### Health Priorities

Map product SKUs/titles to health categories. Use the existing product data in the workspace.

| SKU/Title pattern | Priority |
|---|---|
| `SC-TABS` (Superfood Tabs) | `energy`, `inflammation` |
| `SC-INSTANTCO` / `coffee` | `energy` |
| `SC-ASHW` / `ashwagandha` | `stress`, `cognitive` |
| `SC-CREAMER` | `energy` |
| Any joint/collagen product | `joint_health` |

Make this configurable via a mapping in the function, not hardcoded to specific SKUs. Use a `HEALTH_PRIORITY_KEYWORDS` map that matches against lowercase title + SKU.

### Life Stage Logic

| Condition | Life Stage |
|---|---|
| Inferred age 65+ (from name inference) | `retirement_age` |
| Inferred age 55-64 | `empty_nester` |
| Inferred age 35-54 | `family` |
| Inferred age 25-34 | `young_adult` |
| No age data | `unknown` |

Life stage depends on name inference results, so order history analysis stores what it can (buyer_type, health_priorities, spend stats) and life_stage gets filled in by the orchestrator after name inference completes.

### Return Type

```typescript
export interface OrderDemographics {
  buyer_type: string;
  health_priorities: string[];
  total_orders: number;
  total_spend_cents: number;
  subscription_tenure_days: number;
}
```

---

## 5. Inngest Functions

File: `src/lib/inngest/customer-demographics.ts`

Register all functions in `src/app/api/inngest/route.ts`.

### 5a. `demographics/enrich-batch`

The orchestrator. Runs nightly + on-demand from admin UI.

```typescript
export const enrichBatch = inngest.createFunction(
  {
    id: "demographics-enrich-batch",
    retries: 2,
    concurrency: [{ limit: 1 }],
    triggers: [
      { cron: "0 6 * * *" },  // 1 AM Central = 6 UTC
      { event: "demographics/enrich-batch" },
    ],
  },
  async ({ event, step }) => { ... }
);
```

**Steps:**

1. `step.run("fetch-unenriched")` — Find customers missing demographics or with old `enrichment_version`:
   ```sql
   SELECT c.id, c.first_name, c.workspace_id
   FROM customers c
   LEFT JOIN customer_demographics cd ON cd.customer_id = c.id
   WHERE c.workspace_id = {workspaceId}
     AND (cd.id IS NULL OR cd.enrichment_version < {CURRENT_VERSION})
   LIMIT 500
   ```
   If triggered by event with `workspace_id`, scope to that workspace. If cron, process all workspaces.

2. For each batch of 50 customers: `step.run("batch-{offset}")`:
   a. **Name inference** — collect all first names, call Claude Haiku in a single batch call (see 5b)
   b. **Zip lookup** — for each unique zip code in the batch, call `fetchZipDemographics()` (cached)
   c. **Order history** — for each customer, load orders + subscriptions, run `analyzeOrderHistory()`
   d. **Combine** — merge all three tracks into one `customer_demographics` upsert per customer
   e. **Life stage** — set based on `inferred_age_range` from name inference

3. `step.run("check-remaining")` — If more customers remain, send `demographics/enrich-batch` event to self-continue.

4. Return `{ enriched: count, remaining: remaining_count }`.

### 5b. Name Inference (within batch step)

Call Claude Haiku with batched names for efficiency. Single API call per batch of up to 50 names.

```
You are inferring demographic attributes from first names only.
For each name, infer gender and age range based on name popularity data.

Names:
${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Return a JSON array with one object per name, in the same order:
[{
  "name": "string",
  "gender": "female" | "male" | "unknown",
  "gender_confidence": 0.0-1.0,
  "age_range": "under_25" | "25-34" | "35-44" | "45-54" | "55-64" | "65+",
  "age_confidence": 0.0-1.0,
  "notes": "brief reasoning"
}]

Guidelines:
- gender_confidence >= 0.85 = strong (Linda, Barbara, Michael, James)
- gender_confidence 0.6-0.84 = moderate
- gender_confidence < 0.6 = use "unknown" for gender
- age_confidence >= 0.7 = name peaked in specific decade (Linda peaked 1940s-50s → 65+)
- age_confidence < 0.5 = name too common across decades or too rare
- Never infer race, ethnicity, or national origin
- Return exactly ${names.length} results
```

Model: `claude-haiku-4-5-20251001`, max_tokens: 4096, temperature: 0.

### 5c. `demographics/enrich-single`

Event-driven, for enriching a single customer (e.g., on new customer creation).

```typescript
export const enrichSingle = inngest.createFunction(
  {
    id: "demographics-enrich-single",
    retries: 2,
    concurrency: [{ limit: 10, key: "event.data.workspace_id" }],
    triggers: [{ event: "demographics/enrich-single" }],
  },
  async ({ event, step }) => { ... }
);
```

**Event data:** `{ workspace_id, customer_id }`

**Steps:**
1. `step.run("fetch-customer")` — Load customer (first_name, shipping address zip)
2. `step.run("infer-name")` — Single Claude Haiku call for this one name
3. `step.run("fetch-zip")` — `fetchZipDemographics()` for their zip
4. `step.run("analyze-orders")` — Load orders + subs, run `analyzeOrderHistory()`
5. `step.run("save")` — Upsert `customer_demographics`

### 5d. Wire into existing customer creation

In the Shopify customer webhook handler (`src/lib/shopify-webhooks.ts`), after creating/updating a customer, fire:

```typescript
await inngest.send({
  name: "demographics/enrich-single",
  data: { workspace_id: workspaceId, customer_id: customerId },
});
```

Add a 1-hour delay (`step.sleep("settle", "1h")`) at the start of `enrich-single` to let order data settle.

---

## 6. API Routes

### 6a. Demographics Summary

**`GET /api/workspaces/[id]/demographics/summary`**

Returns aggregate demographic breakdown for all enriched customers.

```typescript
// Response
{
  total_customers: number,
  enriched_count: number,
  gender_distribution: { female: number, male: number, unknown: number },
  age_distribution: { 'under_25': number, '25-34': number, '35-44': number, '45-54': number, '55-64': number, '65+': number },
  income_distribution: { 'under_40k': number, '40-60k': number, ... },
  urban_distribution: { urban: number, suburban: number, rural: number },
  buyer_type_distribution: { committed_subscriber: number, ... },
  top_health_priorities: { priority: string, count: number }[],
  // Pre-formatted target customer string for Product Intelligence
  suggested_target_customer: string,  // e.g. "Women 55-64, suburban, $60-80K household income, health-conscious subscribers"
}
```

The `suggested_target_customer` field is the key integration point with Phase 1 — it auto-generates the target customer description from actual data.

### 6b. Trigger Batch Enrichment

**`POST /api/workspaces/[id]/demographics/enrich`**

Sends Inngest event `demographics/enrich-batch` with workspace_id. Admin/owner only.

```typescript
// Request (optional)
{ force_all?: boolean }  // if true, re-enriches all customers regardless of version
// Response
{ event_id: string }
```

### 6c. Enrichment Status

**`GET /api/workspaces/[id]/demographics/status`**

```typescript
// Response
{
  total_customers: number,
  enriched: number,
  pending: number,
  last_enriched_at: string | null,
  enrichment_version: number,
  zip_codes_cached: number,
}
```

### 6d. Individual Customer Demographics

**`GET /api/workspaces/[id]/customers/[customerId]/demographics`**

```typescript
// Response
{
  demographics: { ...all customer_demographics fields } | null
}
```

This should also be included in the existing customer detail API response if demographics exist.

---

## 7. UI

### 7a. Settings Integration Card

Location: `/dashboard/settings/integrations` (add alongside Klaviyo, Appstle, etc.)

**Card:**
- Icon: government/data icon
- Title: "US Census Bureau"
- Subtitle: "Zip code demographic enrichment — income, education, urban/rural"
- Fields: API Key (password input)
- Helper: "Free key at api.census.gov/data/key_signup.html — optional but recommended for higher rate limits"
- Status: green "Connected" if key set, amber "No key (public access)" if empty
- Save button

### 7b. Demographics Dashboard

Location: `/dashboard/demographics` (new page)

**Add to sidebar:** Under "Customers" group, add "Demographics" link. Owner/admin only.

**Page layout:**

**Header:**
- Title: "Customer Demographics"
- "Run Enrichment" button (triggers batch, shows progress)
- Status line: "X of Y customers enriched" with progress bar

**Summary Cards Row:**
- Gender split (pie chart or bar)
- Age distribution (horizontal bar chart)
- Income brackets (horizontal bar chart)
- Urban/Suburban/Rural (pie chart)

**Suggested Target Customer Card:**
- Highlighted card showing the auto-generated target customer string
- "Copy" button
- "Use in Product Intelligence" button (navigates to product intelligence page with this pre-filled)

**Buyer Types Card:**
- Bar chart: committed_subscriber, new_subscriber, value_buyer, cautious_buyer, one_time_buyer, lapsed_subscriber

**Health Priorities Card:**
- Ranked list with counts: energy, inflammation, joint_health, etc.

**Filters:**
- Filter all charts by: product (which product's customers), date range (order date), subscription status

### 7c. Customer Sidebar Integration

In the existing customer detail sidebar (ticket detail, customer detail pages), add a "Demographics" section if `customer_demographics` exists:

- Gender badge (with confidence %)
- Age range badge (with confidence %)
- Income bracket + urban classification
- Buyer type
- Health priorities as tags

Only show fields with confidence >= 0.65. Below that, omit (don't show "low confidence" — just don't show it).

---

## 8. Constraints

1. **Never infer race/ethnicity** — Claude prompt explicitly excludes this. If Claude returns anything related, drop it.
2. **Confidence thresholds:**
   - >= 0.85: use for segmentation and targeting
   - 0.65-0.84: use for analytics, not individual targeting
   - < 0.65: store but don't display or use
3. **Internal only** — demographic inferences are never shown to customers or in customer-facing interfaces.
4. **Census data is public** — no privacy concern, but attribute it: "Based on US Census ACS 2022 data for zip code XXXXX"
5. **Suppressed Census data** — handle `-666666666` values as null, don't error.
6. **Cache Census data** — one fetch per zip code, refresh annually. ~40K possible US zips.
7. **Enrichment is idempotent** — re-running on an already-enriched customer updates the record, doesn't duplicate.

---

## 9. File Structure

### New files:
```
supabase/migrations/20260420000002_customer_demographics.sql

src/lib/census.ts
src/lib/customer-demographics.ts
src/lib/inngest/customer-demographics.ts

src/app/api/workspaces/[id]/settings/census/route.ts
src/app/api/workspaces/[id]/demographics/summary/route.ts
src/app/api/workspaces/[id]/demographics/enrich/route.ts
src/app/api/workspaces/[id]/demographics/status/route.ts
src/app/api/workspaces/[id]/customers/[customerId]/demographics/route.ts

src/app/dashboard/demographics/page.tsx
src/app/dashboard/settings/integrations/page.tsx  (add Census card — or modify existing)
```

### Modify:
```
src/app/api/inngest/route.ts                    (register 2 new functions)
src/app/dashboard/sidebar.tsx                    (add Demographics link under Customers)
src/lib/shopify-webhooks.ts                     (fire enrich-single on customer create/update)
```

---

## 10. Implementation Sequence

1. **Migration** — Run SQL first
2. **Census client** (`src/lib/census.ts`) — fetchZipDemographics with caching
3. **Order history analyzer** (`src/lib/customer-demographics.ts`) — pure logic, testable immediately
4. **Settings route** — Census API key CRUD + integration card UI
5. **Inngest functions** — enrich-batch + enrich-single, register in inngest route
6. **Demographics API routes** — summary, status, enrich trigger, per-customer
7. **Demographics dashboard page** — summary cards, charts, suggested target customer
8. **Customer sidebar integration** — demographic badges on existing customer views
9. **Webhook integration** — fire enrich-single on new customer creation
10. **Run batch** — enrich all existing customers

### Reference Files for Patterns
- `src/lib/klaviyo.ts` — external API client pattern with encrypted keys
- `src/lib/inngest/sync-reviews.ts` — Inngest batch processing pattern
- `src/app/dashboard/settings/integrations/page.tsx` — integration card pattern (if exists, otherwise check settings pages)
- `src/lib/crypto.ts` — encrypt/decrypt for API keys
- `src/lib/shopify-webhooks.ts` — webhook handler to add enrich-single trigger

---

## 11. Integration with Product Intelligence Engine

The demographics summary endpoint returns `suggested_target_customer` — a pre-formatted string like:

> "Women 55-64, suburban households, $60-80K income, health-conscious long-term subscribers focused on energy and inflammation support"

This string is generated by looking at the mode (most common value) of each demographic dimension among enriched customers. The Product Intelligence Engine's Stage 1 (ingredient input) should:

1. On page load, fetch `/demographics/summary`
2. If `suggested_target_customer` exists and `target_customer` field is empty, pre-fill it
3. Show a subtle label: "Auto-suggested from your customer data" with an edit button

This closes the loop: real customer data → demographic inference → target customer → ingredient research prompts → content generation. No guessing.
