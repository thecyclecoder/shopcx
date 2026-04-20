# Product Intelligence Engine — Phase 1 Implementation Spec

## Overview

This spec covers the complete Product Intelligence Engine as described in the ShopCX Commerce Independence spec (Phase 1). It adds a 5-stage pipeline to existing products: ingredient input, AI ingredient research, AI review analysis, benefit reconciliation (editorial), and content generation. All downstream content derives from this single reconciled selection.

This spec is self-contained. A developer should be able to implement it from a worktree without asking questions.

---

## 1. Database Migrations

File: `supabase/migrations/20260420000001_product_intelligence_engine.sql`

### 1a. Add columns to existing `products` table

The existing `products` table has: `id`, `workspace_id`, `shopify_product_id`, `title`, `handle`, `product_type`, `vendor`, `status`, `tags`, `image_url`, `variants`, `created_at`, `updated_at`, `description`, `inventory_updated_at`, `rating`, `rating_count`.

```sql
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS target_customer TEXT,
  ADD COLUMN IF NOT EXISTS certifications TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS intelligence_status TEXT DEFAULT 'none'
    CHECK (intelligence_status IN ('none', 'ingredients_added', 'researching', 'research_complete', 'analyzing_reviews', 'reviews_complete', 'benefits_selected', 'generating_content', 'content_generated', 'published'));
```

### 1b. `product_ingredients`

```sql
CREATE TABLE public.product_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dosage_mg NUMERIC,
  dosage_display TEXT,           -- e.g. "500mg", "200 IU", "10 billion CFU"
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, name)
);

CREATE INDEX idx_product_ingredients_product ON public.product_ingredients(product_id, display_order);

ALTER TABLE public.product_ingredients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_ingredients" ON public.product_ingredients
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_ingredients" ON public.product_ingredients
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

### 1c. `product_ingredient_research`

```sql
CREATE TABLE public.product_ingredient_research (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES public.product_ingredients(id) ON DELETE CASCADE,
  benefit_headline TEXT NOT NULL,
  mechanism_explanation TEXT NOT NULL,
  clinically_studied_benefits TEXT[] DEFAULT '{}',
  dosage_comparison TEXT,
  citations JSONB DEFAULT '[]',    -- [{title, authors, journal, year, url, doi}]
  contraindications TEXT,
  ai_confidence NUMERIC NOT NULL DEFAULT 0.5 CHECK (ai_confidence >= 0 AND ai_confidence <= 1.0),
  raw_ai_response JSONB,
  researched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ingredient_id, benefit_headline)
);

CREATE INDEX idx_ingredient_research_product ON public.product_ingredient_research(product_id);
CREATE INDEX idx_ingredient_research_ingredient ON public.product_ingredient_research(ingredient_id);

ALTER TABLE public.product_ingredient_research ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_ingredient_research" ON public.product_ingredient_research
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_ingredient_research" ON public.product_ingredient_research
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

### 1d. `product_review_analysis`

```sql
CREATE TABLE public.product_review_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  top_benefits JSONB NOT NULL DEFAULT '[]',
  -- [{benefit, frequency, customer_phrases[], review_ids[]}]
  before_after_pain_points JSONB DEFAULT '[]',
  -- [{before, after, review_ids[]}]
  skeptic_conversions JSONB DEFAULT '[]',
  -- [{summary, quote, review_id, reviewer_name}]
  surprise_benefits JSONB DEFAULT '[]',
  -- [{benefit, quote, review_id}]
  most_powerful_phrases JSONB DEFAULT '[]',
  -- [{phrase, context, review_id, reviewer_name}]
  reviews_analyzed_count INTEGER NOT NULL DEFAULT 0,
  raw_ai_response JSONB,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id)
);

ALTER TABLE public.product_review_analysis ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_review_analysis" ON public.product_review_analysis
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_review_analysis" ON public.product_review_analysis
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

### 1e. `product_benefit_selections`

```sql
CREATE TABLE public.product_benefit_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  benefit_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('lead', 'supporting', 'skip')),
  display_order INTEGER NOT NULL DEFAULT 0,
  science_confirmed BOOLEAN NOT NULL DEFAULT false,
  customer_confirmed BOOLEAN NOT NULL DEFAULT false,
  customer_phrases TEXT[] DEFAULT '{}',
  customer_review_ids UUID[] DEFAULT '{}',
  ingredient_research_ids UUID[] DEFAULT '{}',
  ai_confidence NUMERIC,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, benefit_name)
);

CREATE INDEX idx_benefit_selections_product ON public.product_benefit_selections(product_id, role, display_order);

ALTER TABLE public.product_benefit_selections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_benefit_selections" ON public.product_benefit_selections
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_benefit_selections" ON public.product_benefit_selections
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

### 1f. `product_page_content`

```sql
CREATE TABLE public.product_page_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  hero_headline TEXT,
  hero_subheadline TEXT,
  benefit_bar JSONB DEFAULT '[]',            -- [{icon_hint, text}]
  mechanism_copy TEXT,
  ingredient_cards JSONB DEFAULT '[]',        -- [{name, headline, body, confidence, image_slot}]
  comparison_table_rows JSONB DEFAULT '[]',   -- [{feature, us, competitor_generic}]
  faq_items JSONB DEFAULT '[]',              -- [{question, answer}]
  guarantee_copy TEXT,
  fda_disclaimer TEXT NOT NULL DEFAULT 'These statements have not been evaluated by the Food and Drug Administration. This product is not intended to diagnose, treat, cure, or prevent any disease.',
  knowledge_base_article TEXT,
  kb_what_it_doesnt_do TEXT,
  support_macros JSONB DEFAULT '[]',          -- [{title, body_text, body_html, question_type}]
  raw_ai_response JSONB,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'published')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES auth.users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, version)
);

CREATE INDEX idx_page_content_product ON public.product_page_content(product_id, version DESC);

ALTER TABLE public.product_page_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_page_content" ON public.product_page_content
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_page_content" ON public.product_page_content
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

### 1g. `product_media`

```sql
CREATE TABLE public.product_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,
  url TEXT,
  storage_path TEXT,
  alt_text TEXT DEFAULT '',
  width INTEGER,
  height INTEGER,
  file_size INTEGER,
  mime_type TEXT,
  uploaded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, product_id, slot)
);

CREATE INDEX idx_product_media_product ON public.product_media(product_id);

ALTER TABLE public.product_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated read product_media" ON public.product_media
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT workspace_id FROM public.workspace_members WHERE user_id = auth.uid()));
CREATE POLICY "Service role full on product_media" ON public.product_media
  FOR ALL TO service_role USING (true) WITH CHECK (true);
```

### 1h. Supabase Storage bucket

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('product-media', 'product-media', true, 10485760, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Authenticated users can upload product media"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-media');

CREATE POLICY "Public read product media"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'product-media');

CREATE POLICY "Authenticated users can update product media"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'product-media');

CREATE POLICY "Authenticated users can delete product media"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'product-media');
```

---

## 2. API Routes

All routes follow existing patterns: auth via `createClient().auth.getUser()`, writes via `createAdminClient()`, workspace_id from URL params. Check admin/owner role for writes.

### 2a. Product Intelligence Settings

**`PATCH /api/workspaces/[id]/products/[productId]/intelligence`**

Updates `target_customer` and `certifications` on the product.

```typescript
// Request
{ target_customer?: string, certifications?: string[] }
// Response
{ success: true }
```

### 2b. Ingredients CRUD

**`GET /api/workspaces/[id]/products/[productId]/ingredients`**
```typescript
// Response
{ ingredients: [{ id, name, dosage_mg, dosage_display, display_order }] }
```

**`POST /api/workspaces/[id]/products/[productId]/ingredients`**
```typescript
// Request
{ name: string, dosage_mg?: number, dosage_display?: string }
// Response
{ ingredient: { id, name, dosage_mg, dosage_display, display_order } }
```
Also auto-creates a `product_media` row for slot `ingredient_${name.toLowerCase().replace(/\s+/g, '_')}`.

**`PATCH /api/workspaces/[id]/products/[productId]/ingredients/[ingredientId]`**
```typescript
// Request
{ name?: string, dosage_mg?: number, dosage_display?: string, display_order?: number }
```

**`DELETE /api/workspaces/[id]/products/[productId]/ingredients/[ingredientId]`**
Cascades: deletes related `product_ingredient_research` rows and the ingredient image slot.

**`POST /api/workspaces/[id]/products/[productId]/ingredients/reorder`**
```typescript
// Request
{ order: [{ id: string, display_order: number }] }
```

### 2c. Trigger Research

**`POST /api/workspaces/[id]/products/[productId]/research`**
Sends Inngest event `intelligence/research-ingredients`. Sets `intelligence_status = 'researching'`.
```typescript
// Request
{ ingredient_ids?: string[] }  // optional: re-research specific ingredients only
// Response
{ event_id: string }
```

### 2d. Trigger Review Analysis

**`POST /api/workspaces/[id]/products/[productId]/analyze-reviews`**
Sends Inngest event `intelligence/analyze-reviews`. Sets `intelligence_status = 'analyzing_reviews'`.
```typescript
// Response
{ event_id: string }
```

### 2e. Research Results

**`GET /api/workspaces/[id]/products/[productId]/research`**
```typescript
// Response
{
  status: 'pending' | 'complete' | 'partial',
  ingredients: [{
    id, name, dosage_display,
    research: [{
      id, benefit_headline, mechanism_explanation, clinically_studied_benefits,
      dosage_comparison, citations, contraindications, ai_confidence, researched_at
    }]
  }]
}
```

### 2f. Review Analysis Results

**`GET /api/workspaces/[id]/products/[productId]/review-analysis`**
```typescript
// Response
{
  analysis: {
    top_benefits, before_after_pain_points, skeptic_conversions,
    surprise_benefits, most_powerful_phrases, reviews_analyzed_count, analyzed_at
  } | null
}
```

### 2g. Benefit Selections

**`GET /api/workspaces/[id]/products/[productId]/benefit-selections`**
Returns merged view of science + customer benefits with current selections plus AI-generated suggestions for benefits not yet selected.
```typescript
// Response
{
  benefits: [{
    id, benefit_name, role, display_order, science_confirmed, customer_confirmed,
    customer_phrases, ai_confidence, notes,
    science_sources: [{ ingredient_name, benefit_headline, confidence }],
    customer_sources: [{ phrase, review_id }]
  }],
  suggestions: [{
    benefit_name, science_confirmed, customer_confirmed,
    recommendation: 'lead' | 'supporting' | 'skip',
    reason: string
  }]
}
```

**`PUT /api/workspaces/[id]/products/[productId]/benefit-selections`**
Saves the full set of benefit selections (replaces all). **Reject with 400 if any benefit with `ai_confidence < 0.5` has `role = 'lead'`.**
```typescript
// Request
{
  benefits: [{
    benefit_name: string, role: 'lead' | 'supporting' | 'skip', display_order: number,
    science_confirmed: boolean, customer_confirmed: boolean,
    customer_phrases?: string[], customer_review_ids?: string[],
    ingredient_research_ids?: string[], ai_confidence?: number, notes?: string
  }]
}
```
Sets `intelligence_status = 'benefits_selected'`.

### 2h. Trigger Content Generation

**`POST /api/workspaces/[id]/products/[productId]/generate-content`**
Sends Inngest event `intelligence/generate-content`. Sets `intelligence_status = 'generating_content'`.
```typescript
// Response
{ event_id: string }
```

### 2i. Content CRUD

**`GET /api/workspaces/[id]/products/[productId]/page-content`**
Returns latest version of generated content plus version history.

**`PATCH /api/workspaces/[id]/products/[productId]/page-content/[contentId]`**
Edits individual fields on generated content before approval.

### 2j. Approve / Publish

**`POST /api/workspaces/[id]/products/[productId]/page-content/[contentId]/approve`**
Sets `status = 'approved'`, `approved_at`, `approved_by`.

**`POST /api/workspaces/[id]/products/[productId]/page-content/[contentId]/publish`**
Sets `status = 'published'`, `published_at`, `intelligence_status = 'published'`.
**Must verify `kb_what_it_doesnt_do` is non-empty before publishing.**
Creates macros from `support_macros` into existing `macros` table with `status = 'pending'`.
Creates/updates KB article from `knowledge_base_article` + `kb_what_it_doesnt_do`.

### 2k. Image Upload

**`POST /api/workspaces/[id]/products/[productId]/media/[slot]`**
Accepts multipart form upload. Uploads to Supabase Storage at `products/{product_id}/{slot}/{filename}`. Upserts `product_media` row.

**`DELETE /api/workspaces/[id]/products/[productId]/media/[slot]`**
Removes from storage and clears `product_media` row.

### 2l. Intelligence Overview

**`GET /api/workspaces/[id]/products/[productId]/intelligence-overview`**
Single endpoint returning all intelligence data for the full 5-stage UI.
```typescript
// Response
{
  product: { id, title, target_customer, certifications, intelligence_status, image_url },
  ingredients: [...],
  research: { status, ingredients_with_research: [...] },
  review_analysis: { ... } | null,
  benefit_selections: [...],
  page_content: { ... } | null,
  media: [{ slot, url, alt_text }]
}
```

---

## 3. Inngest Functions

File: `src/lib/inngest/product-intelligence.ts`

Register all 3 in `src/app/api/inngest/route.ts`.

### 3a. `intelligence/research-ingredients`

```typescript
export const researchIngredients = inngest.createFunction(
  {
    id: "intelligence-research-ingredients",
    retries: 2,
    concurrency: [{ limit: 5, key: "event.data.workspace_id" }],
    triggers: [{ event: "intelligence/research-ingredients" }],
  },
  async ({ event, step }) => { ... }
);
```

**Event data:** `{ workspace_id, product_id, ingredient_ids?: string[] }`

**Steps:**
1. `step.run("fetch-ingredients")` — Load product + ingredients. If `ingredient_ids` provided, filter.
2. Per ingredient: `step.run("research-{ingredient.id}")` — Claude Sonnet 4 call:

```
You are a nutritional science researcher. Research the ingredient "${name}" at a dosage of ${dosage_display}.

Target customer profile: ${target_customer || 'general adult population'}

For this ingredient, provide each clinically studied benefit as a separate object:
- benefit_headline (e.g. "Supports Joint Flexibility")
- mechanism_explanation (2-3 sentences)
- dosage_comparison (how product dosage compares to studied ranges)
- citations [{title, authors, journal, year, doi}]
- contraindications for ${target_customer}
- ai_confidence:
  1.0 = multiple RCTs, 0.8 = single RCT, 0.7 = meta-analysis observational,
  0.5 = observational only, 0.3 = traditional use, 0.1 = theoretical

Return JSON array. Be conservative with confidence scores.
```

Model: `claude-sonnet-4-20250514`, max_tokens: 4096, temperature: 0.

3. Parse JSON, upsert `product_ingredient_research` rows. Store `raw_ai_response`.
4. `step.run("update-status")` — Set `intelligence_status = 'research_complete'`.

### 3b. `intelligence/analyze-reviews`

```typescript
export const analyzeReviews = inngest.createFunction(
  {
    id: "intelligence-analyze-reviews",
    retries: 2,
    concurrency: [{ limit: 3, key: "event.data.workspace_id" }],
    triggers: [{ event: "intelligence/analyze-reviews" }],
  },
  async ({ event, step }) => { ... }
);
```

**Event data:** `{ workspace_id, product_id }`

**Steps:**
1. `step.run("fetch-reviews")` — Load from `product_reviews` where `shopify_product_id` matches, status published/featured, body not null, limit 500.
2. `step.run("analyze")` — Claude Sonnet 4 with all reviews. Returns: `top_benefits`, `before_after_pain_points`, `skeptic_conversions`, `surprise_benefits`, `most_powerful_phrases`.

**Critical rule in prompt:** Every quote must be an EXACT substring from the review text. Every review_id must be real. Validate after parsing — drop any quote with invalid review_id.

3. Upsert `product_review_analysis` (one row per product, replaced on re-run).
4. `step.run("update-status")` — Set `intelligence_status = 'reviews_complete'`.

### 3c. `intelligence/generate-content`

```typescript
export const generateContent = inngest.createFunction(
  {
    id: "intelligence-generate-content",
    retries: 1,
    concurrency: [{ limit: 2, key: "event.data.workspace_id" }],
    triggers: [{ event: "intelligence/generate-content" }],
  },
  async ({ event, step }) => { ... }
);
```

**Event data:** `{ workspace_id, product_id }`

**Steps:**
1. `step.run("fetch-context")` — Load product, ingredients with research, review analysis, benefit selections (lead + supporting only), media slots.
2. `step.run("generate")` — Single Claude Sonnet 4 call with full context. Generates all assets:
   - `hero_headline`, `hero_subheadline`, `benefit_bar`, `mechanism_copy`
   - `ingredient_cards`, `comparison_table_rows`, `faq_items`, `guarantee_copy`
   - `knowledge_base_article`, `kb_what_it_doesnt_do`
   - `support_macros` (5 macros, one per question type: ingredients, dosage, benefits, side_effects, usage)

Model: `claude-sonnet-4-20250514`, max_tokens: 8192, temperature: 0.2.

**Prompt rules:**
- Hero headline uses outcome language from customer reviews, not clinical language
- Never claim benefits with confidence < 0.5 as primary claims
- benefit_bar: exactly 4-6 items, lead benefits first
- FAQ: 5-8 items
- Compare to generic alternatives, never name competitor brands
- Never invent customer quotes

3. Parse JSON. Determine next version (`MAX(version) + 1`). Insert into `product_page_content` with `status = 'draft'`.
4. `step.run("update-status")` — Set `intelligence_status = 'content_generated'`.

---

## 4. UI Page

### `/dashboard/products/[id]/intelligence/page.tsx`

**Layout:**
- Back link to `/dashboard/products`
- Product header: image, title, status badge (`intelligence_status`)
- 5-stage tabs: `Ingredients` | `Research` | `Reviews` | `Benefits` | `Content`
- Image Management section at bottom (always visible)

**Stage 1 — Ingredient Input:**
- Target Customer text input (pre-filled from workspace default)
- Certifications tag input
- Ingredients table: Name | Dosage | Dosage Display | Actions (edit, delete, drag reorder)
- "Add Ingredient" row
- "Start Research" button (disabled until >= 1 ingredient) — triggers both research AND review analysis in parallel
- Save all before triggering

**Stage 2 — Research Results (read-only):**
- Shows when `intelligence_status >= research_complete`
- Accordion per ingredient showing benefit cards:
  - Headline, mechanism, dosage comparison
  - Confidence badge: green >= 0.8, amber 0.5-0.79, red < 0.5
  - Citations expandable
  - Contraindications warning box if present
- "Re-research" button per ingredient or all
- Polling: while researching, poll `/research` every 3s

**Stage 3 — Review Analysis (read-only):**
- Shows when `intelligence_status >= reviews_complete`
- "Top Benefits Customers Mention" — ranked list with frequency, expandable phrases
- "Before & After" — transformation cards
- "Skeptics Who Became Believers" — quote cards
- "Surprise Benefits" — highlighted list
- "Most Powerful Phrases" — copywriting-ready grid
- "Based on X reviews" badge
- "Re-analyze" button

**Stage 4 — Benefit Reconciliation (interactive editor):**
- Shows when both research AND review analysis are complete
- Pre-populated from suggestions
- Three-column table:

| Science | Customers | Your Selection |
|---------|-----------|----------------|
| Benefit headline + confidence badge | Frequency + top phrase | Dropdown: Lead / Supporting / Skip |

- Row colors: green = both confirmed, yellow = science only, blue = customer only
- If `ai_confidence < 0.5` and user selects Lead → warning tooltip
- Drag reorder within Lead role
- "Save Selections" button

**Stage 5 — Generated Content (editable):**
- Shows when `intelligence_status >= content_generated`
- Editable sections: Hero headline/subheadline, Benefit bar, Mechanism copy (rich text), Ingredient cards, Comparison table, FAQ, Guarantee, KB article (markdown editor), "What it doesn't do", Support macros
- FDA disclaimer shown but not editable
- Version dropdown
- Buttons: "Regenerate", "Approve", "Publish"
- Status badge: Draft / Approved / Published

**Image Management (always visible):**
- Grid of upload slots: hero, lifestyle_1, lifestyle_2, packaging, ingredient_[per ingredient], ugc_1-6, comparison
- Each: drag-and-drop upload area, preview thumbnail, alt text input, delete button
- Ingredient slots auto-created when ingredients are added

### Existing Product Page Link

Add a link/button on `/dashboard/products/[id]/page.tsx` that navigates to `/dashboard/products/[id]/intelligence`. Label: "Product Intelligence Engine".

---

## 5. Constraints (enforce in code)

1. **Confidence floor:** API rejects `role = 'lead'` if `ai_confidence < 0.5` with 400 error. UI shows warning.
2. **FDA disclaimer:** Not editable. Always rendered. Default value in DB.
3. **KB "What it doesn't do":** Publish endpoint blocks if empty.
4. **Review quotes must be real:** Inngest function validates every `review_id` exists. Drops invalid quotes.
5. **No silent regeneration:** Research only on explicit button click. No cron. No auto-trigger.
6. **Nothing auto-publishes:** Content is always `draft`. Must be explicitly approved then published. Macros created as `pending`.

---

## 6. File Structure

### New files:
```
supabase/migrations/20260420000001_product_intelligence_engine.sql

src/lib/inngest/product-intelligence.ts

src/app/api/workspaces/[id]/products/[productId]/intelligence/route.ts
src/app/api/workspaces/[id]/products/[productId]/ingredients/route.ts
src/app/api/workspaces/[id]/products/[productId]/ingredients/[ingredientId]/route.ts
src/app/api/workspaces/[id]/products/[productId]/ingredients/reorder/route.ts
src/app/api/workspaces/[id]/products/[productId]/research/route.ts
src/app/api/workspaces/[id]/products/[productId]/analyze-reviews/route.ts
src/app/api/workspaces/[id]/products/[productId]/review-analysis/route.ts
src/app/api/workspaces/[id]/products/[productId]/benefit-selections/route.ts
src/app/api/workspaces/[id]/products/[productId]/generate-content/route.ts
src/app/api/workspaces/[id]/products/[productId]/page-content/route.ts
src/app/api/workspaces/[id]/products/[productId]/page-content/[contentId]/route.ts
src/app/api/workspaces/[id]/products/[productId]/page-content/[contentId]/approve/route.ts
src/app/api/workspaces/[id]/products/[productId]/page-content/[contentId]/publish/route.ts
src/app/api/workspaces/[id]/products/[productId]/media/[slot]/route.ts
src/app/api/workspaces/[id]/products/[productId]/intelligence-overview/route.ts

src/app/dashboard/products/[id]/intelligence/page.tsx
```

### Modify:
```
src/app/api/inngest/route.ts                    (register 3 new functions)
src/app/dashboard/products/[id]/page.tsx         (add link to intelligence page)
```

---

## 7. Implementation Sequence

1. **Migration** — Run SQL migration first
2. **Inngest functions** — Build `product-intelligence.ts` with all 3 functions. Register in inngest route.
3. **API routes** — Build in order: ingredients CRUD → intelligence PATCH → research trigger + GET → analyze-reviews → review-analysis GET → benefit-selections → generate-content → page-content CRUD + approve + publish → media upload → intelligence-overview
4. **UI** — Build intelligence page starting with Stage 1 (testable immediately), then Stages 2+3 (read-only), Stage 4 (editor), Stage 5 (content)
5. **Integration** — Add link from existing product detail page

### Reference Files for Patterns
- `src/lib/inngest/sync-reviews.ts` — Inngest function pattern with step.run, Claude calls
- `src/app/api/workspaces/[id]/products/route.ts` — API route auth pattern
- `src/app/dashboard/products/[id]/page.tsx` — existing product detail page to link from
- `src/app/api/inngest/route.ts` — Inngest function registration
