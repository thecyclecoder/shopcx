-- Posts — our own copy of Shopify blog articles (Superfood Scoop), the canonical
-- blog/resource object (storefront-renderable later). Some are flagged as
-- product resources + grouped, surfaced in the portal Resources section.
-- See specs/blog-resources.md.
CREATE TABLE IF NOT EXISTS public.posts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  shopify_article_id TEXT NOT NULL,            -- import idempotency key
  blog_handle        TEXT,                     -- 'superfood-scoop'
  handle             TEXT,                     -- article slug

  title              TEXT NOT NULL,
  excerpt            TEXT,
  content_html       TEXT,                     -- image URLs rewritten to OUR storage
  content_text       TEXT,                     -- stripped, for search + future embedding
  featured_image_url TEXT,                     -- OUR storage (migrated off Shopify)
  seo_title          TEXT,
  seo_description    TEXT,
  tags               TEXT[] NOT NULL DEFAULT '{}'::text[],

  -- AI classification (during import).
  is_resource        BOOLEAN NOT NULL DEFAULT false,
  grouping           TEXT,                     -- recipes|how_it_works|how_to_use|science|general (null when not a resource)

  published          BOOLEAN NOT NULL DEFAULT true,
  published_at       TIMESTAMPTZ,
  source             TEXT NOT NULL DEFAULT 'shopify_blog',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT posts_ws_article_key UNIQUE (workspace_id, shopify_article_id)
);

CREATE INDEX IF NOT EXISTS posts_ws_resource_idx ON public.posts (workspace_id, is_resource, published);
CREATE INDEX IF NOT EXISTS posts_ws_handle_idx ON public.posts (workspace_id, handle);

-- A post can be a resource for MANY products (a recipe using Creamer + Coffee
-- shows under both). Grouping lives on the post; this is just the product link.
CREATE TABLE IF NOT EXISTS public.post_products (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  post_id      UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  product_id   UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT post_products_key UNIQUE (post_id, product_id)
);
CREATE INDEX IF NOT EXISTS post_products_product_idx ON public.post_products (workspace_id, product_id);

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY posts_ws_read ON public.posts FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY posts_service ON public.posts FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY post_products_ws_read ON public.post_products FOR SELECT TO authenticated
  USING (workspace_id = (auth.jwt() ->> 'workspace_id')::uuid);
CREATE POLICY post_products_service ON public.post_products FOR ALL TO service_role USING (true) WITH CHECK (true);
