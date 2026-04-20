# Customer Demographic Inference
## ShopCX Feature Spec

Infer demographic attributes from existing customer data — name, address, and order history — to enable better segmentation, ad targeting, and personalization. No surveys. No data purchases. Built on what we already have.

---

## What We Can Infer

### From Name → Gender + Age Range

First names are strongly gendered and strongly era-specific. This is the highest-value inference available from existing data.

**Gender:** Claude classifies first name as female/male/unknown with a confidence score. "Margaret," "Linda," "Susan," "Carol" → female, ~95%+ confidence. Ambiguous names (Jordan, Taylor, Alex) → flagged as unknown.

**Age range:** Name popularity peaked by decade. Well-documented in Social Security Administration name frequency data.

| Name examples | Likely birth decade | Age range in 2026 |
|---|---|---|
| Linda, Barbara, Patricia, Carol | 1940s-50s | 65-80 |
| Deborah, Sharon, Karen, Susan | 1950s-60s | 60-75 |
| Donna, Brenda, Cynthia, Sandra | 1960s | 55-65 |
| Lisa, Michelle, Kim, Donna | 1960s-70s | 50-65 |
| Jennifer, Amy, Angela, Melissa | 1970s-80s | 40-55 |
| Ashley, Jessica, Amanda, Stephanie | 1980s | 35-45 |
| Emily, Hannah, Brittany, Megan | 1990s | 30-40 |

This is directionally accurate at the cohort level — not a perfect individual predictor but highly useful for population-level segmentation.

### From Zip Code → Income + Local Demographics (Census API)

The US Census Bureau provides free demographic data at the zip code level via their public API. No account required, no cost, no rate limits that matter at our scale.

**What the Census API returns per zip code:**
- Median household income
- Median age of residents
- Educational attainment distribution
- Owner vs renter split
- Population density (urban/suburban/rural classification)

This is actual measured data, not inference — more reliable than anything Claude can infer from an address.

### From Order History → Life Stage + Health Priorities

- **Products purchased over time** → which health concerns they're actively addressing
- **Subscription tenure** → committed health-conscious vs casual buyer
- **Bundle size preference** → value-oriented (6-bag) vs cautious (1-bag)
- **Reorder frequency vs subscription** → price sensitive vs convenience-oriented
- **Which products they've tried** → cross-category health profile

---

## Architecture

### Two-Track Enrichment

Run both tracks in parallel via Inngest when a customer record is created or when the batch enrichment job runs on existing customers.

**Track A — Name inference (Claude)**
Batch job processes customers missing demographic data. Runs against the existing Anthropic API integration in ShopCX.

**Track B — Zip code enrichment (Census API)**
Fetches zip code demographics from the US Census Bureau American Community Survey (ACS) 5-year estimates API. Cached per zip code — 40,000 US zip codes max, so cache the results in a lookup table rather than calling the API per customer.

---

## Database

### New Table: `customer_demographics`

```sql
CREATE TABLE customer_demographics (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id               uuid REFERENCES customers(id) NOT NULL UNIQUE,
  workspace_id              uuid NOT NULL,

  -- Name inference (Claude)
  inferred_gender           text CHECK (inferred_gender IN ('female', 'male', 'unknown')),
  inferred_gender_conf      float CHECK (inferred_gender_conf BETWEEN 0 AND 1),
  inferred_age_range        text CHECK (inferred_age_range IN (
                              'under_25', '25-34', '35-44', '45-54', '55-64', '65+'
                            )),
  inferred_age_conf         float CHECK (inferred_age_conf BETWEEN 0 AND 1),
  name_inference_notes      text,  -- Claude's reasoning, for debugging

  -- Zip code enrichment (Census API)
  zip_median_income         int,   -- annual household income in USD
  zip_median_age            float,
  zip_income_bracket        text CHECK (zip_income_bracket IN (
                              'under_40k', '40-60k', '60-80k', '80-100k',
                              '100-125k', '125-150k', '150k+'
                            )),
  zip_urban_classification  text CHECK (zip_urban_classification IN (
                              'urban', 'suburban', 'rural'
                            )),
  zip_owner_pct             float, -- % of households that own vs rent
  zip_college_pct           float, -- % with bachelor's degree or higher

  -- Order history inference
  inferred_life_stage       text CHECK (inferred_life_stage IN (
                              'young_adult', 'family', 'empty_nester', 'retirement_age', 'unknown'
                            )),
  health_priorities         text[], -- e.g. ['energy', 'joint_health', 'inflammation']
  buyer_type                text CHECK (buyer_type IN (
                              'value_buyer',      -- prefers bundles
                              'cautious_buyer',   -- 1-bag, low commitment
                              'committed_subscriber', -- long-tenure sub
                              'lapsed_subscriber',
                              'one_time_buyer'
                            )),

  -- Metadata
  enriched_at               timestamptz DEFAULT now(),
  enrichment_version        int DEFAULT 1,  -- increment when logic changes
  census_data_year          int            -- which ACS year was used
);

CREATE INDEX ON customer_demographics (workspace_id);
CREATE INDEX ON customer_demographics (inferred_gender);
CREATE INDEX ON customer_demographics (inferred_age_range);
CREATE INDEX ON customer_demographics (zip_income_bracket);
```

### New Table: `zip_code_demographics` (Cache)

```sql
CREATE TABLE zip_code_demographics (
  zip_code              text PRIMARY KEY,
  median_income         int,
  median_age            float,
  owner_pct             float,
  college_pct           float,
  population_density    float,  -- people per sq mile
  urban_classification  text,
  state                 text,
  fetched_at            timestamptz DEFAULT now(),
  acs_year              int       -- e.g. 2022 (5-year estimates)
);
```

Cache zip code data at enrichment time. Refresh annually (ACS data updates yearly). ~40K rows max — tiny table.

---

## US Census Bureau API Integration

### Endpoint

```
https://api.census.gov/data/{year}/acs/acs5
```

No API key required for reasonable usage. For production volumes, register for a free key at api.census.gov to get higher rate limits.

### Variables to Fetch

| Census Variable | What It Is | How We Use It |
|---|---|---|
| `B19013_001E` | Median household income | `zip_median_income`, `zip_income_bracket` |
| `B01002_001E` | Median age | `zip_median_age` |
| `B25003_002E` | Owner-occupied housing units | Calculate `zip_owner_pct` |
| `B25003_001E` | Total occupied housing units | Denominator for owner % |
| `B15003_022E` | Bachelor's degree holders | Calculate `zip_college_pct` |
| `B15003_001E` | Total population 25+ | Denominator for college % |
| `B01003_001E` | Total population | Used with land area for density |

### Example Request

```typescript
async function fetchZipDemographics(zip: string): Promise<ZipDemographics> {
  // Check cache first
  const cached = await supabase
    .from('zip_code_demographics')
    .select('*')
    .eq('zip_code', zip)
    .single();

  if (cached.data) return cached.data;

  const variables = [
    'B19013_001E',  // median income
    'B01002_001E',  // median age
    'B25003_001E',  // total housing units
    'B25003_002E',  // owner-occupied
    'B15003_001E',  // total pop 25+
    'B15003_022E',  // bachelor's degree
    'B01003_001E',  // total population
  ].join(',');

  const url = `https://api.census.gov/data/2022/acs/acs5` +
    `?get=${variables}` +
    `&for=zip%20code%20tabulation%20area:${zip}` +
    `&key=${process.env.CENSUS_API_KEY}`;

  const res = await fetch(url);
  const data = await res.json();

  // data[0] = headers, data[1] = values
  const [headers, values] = data;
  const row: Record<string, number> = {};
  headers.forEach((h: string, i: number) => { row[h] = Number(values[i]); });

  const medianIncome = row['B19013_001E'];
  const ownerPct = row['B25003_002E'] / row['B25003_001E'];
  const collegePct = row['B15003_022E'] / row['B15003_001E'];

  const result = {
    zip_code: zip,
    median_income: medianIncome,
    median_age: row['B01002_001E'],
    owner_pct: ownerPct,
    college_pct: collegePct,
    urban_classification: classifyUrban(row['B01003_001E']),
    acs_year: 2022,
  };

  // Cache it
  await supabase.from('zip_code_demographics').insert(result);

  return result;
}

function classifyUrban(totalPop: number): 'urban' | 'suburban' | 'rural' {
  // Rough classification by population density proxy
  // A proper implementation would use land area from Census TIGER data
  if (totalPop > 50000) return 'urban';
  if (totalPop > 10000) return 'suburban';
  return 'rural';
}

function incomeTobracket(income: number): string {
  if (income < 40000) return 'under_40k';
  if (income < 60000) return '40-60k';
  if (income < 80000) return '60-80k';
  if (income < 100000) return '80-100k';
  if (income < 125000) return '100-125k';
  if (income < 150000) return '125-150k';
  return '150k+';
}
```

### Census API Notes

- Free, no rate limit issues at our scale
- Register at https://api.census.gov/data/key_signup.html for a free key (optional but recommended for production)
- ACS 5-year estimates are the most reliable — they aggregate 5 years of survey data so small zip codes have statistically meaningful results
- Use `2022` as the year (most recent 5-year estimates available as of 2026)
- Some zip codes return `-666666666` for suppressed data (too few respondents) — handle gracefully, store as null

---

## Claude Inference — Name → Gender + Age

### Inngest Function: `demographics/infer-from-name`

```typescript
// Prompt for Claude
const prompt = `
Infer demographic attributes from this customer's first name only.
Do not use any other information. Return JSON only, no preamble.

First name: "${firstName}"

{
  "gender": "female" | "male" | "unknown",
  "gender_confidence": 0.0-1.0,
  "age_range": "under_25" | "25-34" | "35-44" | "45-54" | "55-64" | "65+",
  "age_confidence": 0.0-1.0,
  "notes": "brief reasoning"
}

Guidelines:
- gender_confidence above 0.85 = strong signal (Linda, Barbara, Michael, James)
- gender_confidence 0.6-0.85 = moderate signal
- gender_confidence below 0.6 = use "unknown"
- age_confidence above 0.7 = name peaked in a specific decade (Linda peaked 1940s-50s)
- age_confidence below 0.5 = name is too common across decades or too rare
- For names popular across multiple decades, lower the age_confidence
- Never infer race, ethnicity, or national origin
`
```

Run in batches of 50 customers via a single Inngest step. Use `claude-haiku-4-5` for this — it's fast, cheap, and the task is simple enough that Sonnet is overkill. Cost is negligible (~$0.001 per 1000 customers).

### Confidence Thresholds for Use

| Confidence | Action |
|---|---|
| ≥ 0.85 | Use for segmentation and targeting |
| 0.65-0.84 | Use for analytics/reporting, not individual targeting |
| < 0.65 | Store but do not use for segmentation — flag as unreliable |

---

## Order History Analysis

### Inngest Function: `demographics/analyze-order-history`

No AI needed for this — pure logic on order data already in ShopCX.

```typescript
function analyzeOrderHistory(orders: Order[]): OrderDemographics {
  const subscriptionOrders = orders.filter(o => o.is_subscription);
  const oneTimeOrders = orders.filter(o => !o.is_subscription);
  const totalSpend = orders.reduce((sum, o) => sum + o.total_cents, 0);
  const avgOrderValue = totalSpend / orders.length;

  // Subscription tenure in days
  const firstSubOrder = subscriptionOrders.sort((a, b) =>
    new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )[0];
  const subTenureDays = firstSubOrder
    ? Math.floor((Date.now() - new Date(firstSubOrder.created_at).getTime()) / 86400000)
    : 0;

  // Bundle preference
  const bundleOrders = orders.filter(o => o.quantity >= 3);
  const bundleRate = bundleOrders.length / orders.length;

  // Determine buyer type
  let buyerType: string;
  if (subTenureDays > 180) buyerType = 'committed_subscriber';
  else if (subTenureDays > 0 && subTenureDays <= 180) buyerType = 'new_subscriber';
  else if (oneTimeOrders.length === 1) buyerType = 'one_time_buyer';
  else if (bundleRate > 0.6) buyerType = 'value_buyer';
  else buyerType = 'cautious_buyer';

  // Health priorities from product history
  const productNames = orders.flatMap(o => o.line_items.map(i => i.product_name));
  const healthPriorities = inferHealthPriorities(productNames);

  // Life stage from product mix and order patterns
  const lifeStage = inferLifeStage(productNames, avgOrderValue, subTenureDays);

  return { buyerType, healthPriorities, lifeStage };
}

function inferHealthPriorities(productNames: string[]): string[] {
  const priorities: string[] = [];
  const text = productNames.join(' ').toLowerCase();

  if (text.includes('joint') || text.includes('collagen')) priorities.push('joint_health');
  if (text.includes('energy') || text.includes('coffee')) priorities.push('energy');
  if (text.includes('sleep') || text.includes('calm') || text.includes('rest')) priorities.push('sleep');
  if (text.includes('weight') || text.includes('metabolism')) priorities.push('weight_management');
  if (text.includes('immune') || text.includes('defense')) priorities.push('immunity');
  if (text.includes('focus') || text.includes('brain') || text.includes('nootropic')) priorities.push('cognitive');

  return priorities;
}
```

---

## Batch Enrichment Job

### Inngest Function: `demographics/enrich-batch`

Runs nightly on all customers missing demographic data. Also triggered on new customer creation (delay 1 hour to let order data settle).

```
Step 1: Fetch customers without customer_demographics row (limit 500 per run)
Step 2: For each customer in parallel (concurrency: 20):
  - Run name inference (Claude Haiku)
  - Run zip code enrichment (Census API, cached)
  - Run order history analysis (local logic, no external calls)
Step 3: Write all results to customer_demographics
Step 4: If more customers remain, re-queue self
```

On schema or logic changes, increment `enrichment_version` and re-run for all customers with the old version.

---

## Admin UI

### Location: `/customers/demographics` in ShopCX

**Summary cards across all customers:**
- Gender distribution (with confidence breakdown)
- Age range distribution
- Income bracket distribution (from zip code data)
- Buyer type breakdown
- Top health priorities

**Usage in customer list:**
- Add demographic columns to customer table (filterable)
- Allow creating segments by: gender, age range, income bracket, buyer type, health priorities

**Individual customer record:**
- Show demographic inferences in the sidebar
- Display confidence scores
- Show Census data source attribution ("Based on zip code 00920 — US Census ACS 2022")
- Never show this data to the customer themselves — internal only

---

## Segmentation Examples

Once enriched, segments you can build immediately:

| Segment | Definition | Use |
|---|---|---|
| Core customer | female, 55-64, zip_median_income > $60k, committed_subscriber | Loyalty campaigns, referral ask |
| High-value prospects | female, 65+, zip_median_income > $80k, one_time_buyer | Win-back, subscription upsell |
| Younger acquirers | female, 35-44, energy health priority | Different ad creative, energy angle |
| Value seekers | value_buyer, any age | Bundle promotions, quantity break emphasis |
| At-risk subscribers | committed_subscriber, last order > 45 days | Proactive save offer |

---

## Meta / Google Audience Enrichment

The demographic data also improves ad platform targeting:

- Upload customer list to Meta with `age_range` and `gender` as additional match signals
- Meta's Customer Audience matching improves when you provide these alongside email/phone
- Use demographic segments to create lookalike audiences by segment rather than all customers — "lookalikes of committed subscribers aged 55-64" outperforms "lookalikes of all customers"

---

## Privacy & Ethics

- Store all inferences as `inferred_*` — never presented as ground truth
- Do not surface inferred demographic data to customers or in customer-facing interfaces
- Do not infer race, ethnicity, or national origin from names — Claude prompt explicitly excludes this
- Use for: internal segmentation, ad targeting, content personalization, analytics
- Do not use for: pricing differences, service quality differences, anything that could constitute discrimination
- Census zip code data is aggregate public data — no individual privacy concern
- Name-based inference is industry standard practice (used by every major DTC analytics platform)
- Add a note in privacy policy: "We may infer demographic information from publicly available data sources to improve our marketing and product recommendations"

---

## Implementation Order

1. Create `zip_code_demographics` table and Census API fetch function
2. Create `customer_demographics` table
3. Build `demographics/infer-from-name` Inngest function (Claude Haiku)
4. Build `demographics/analyze-order-history` logic
5. Build `demographics/enrich-batch` orchestrator
6. Run batch on all existing customers
7. Build admin dashboard summary view
8. Wire demographic fields into customer list filters
9. Build segment builder using demographic fields

**Start with the Census zip code enrichment** — it's deterministic, free, and covers income/age without any AI inference. You'll see immediate value. Name inference comes second. Together they give you a complete demographic picture of your customer base within a single batch run.
