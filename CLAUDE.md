# ShopCX.ai

The retention operating system for Superfoods Company. Replaces Gorgias + Siena AI + Appstle + Klaviyo with a unified, multi-tenant SaaS platform.

- Domain: https://shopcx.ai · GitHub: thecyclecoder/shopcx · Vercel: dylan-ralstons-projects/shopcx
- Stack: Next.js 16 (App Router), Supabase (Postgres + RLS + pgvector), Inngest, Vercel, Resend, Twilio, EasyPost, Braintree, Avalara, Shopify, Appstle, Klaviyo, Meta Graph, Anthropic, OpenAI embeddings.

## Authoritative reference: `docs/brain/`

`docs/brain/` is the system map. Six folders covering every table, Inngest function, integration, library file, journey, playbook, lifecycle, and recipe. **Read it before grepping `src/`.** Start at `docs/brain/README.md`.

| Folder | What |
|---|---|
| `tables/` | One page per `public.*` table — columns, FKs, queries, gotchas |
| `inngest/` | One page per `src/lib/inngest/*.ts` — triggers + events + table writes |
| `integrations/` | One page per external API — auth, credentials, endpoints, retries |
| `libraries/` | One page per `src/lib/*.ts` — exports, signatures, callers |
| `journeys/` + `playbooks/` | Per-row in `journey_definitions` / `playbooks` tables |
| `lifecycles/` | Long-form end-to-end traces of major flows |
| `recipes/` | How-to pages for common operational tasks |

**Hard rule:** every new feature / table / Inngest function / integration / library file must land in `docs/brain/` in the same PR. Code without a brain page is incomplete.

## Local conventions

These can't live in a wiki page — they're project-wide invariants:

- **Database is the spec.** Status enums, column shapes — probe before assuming. See [Probing technique](docs/brain/README.md#probing-technique).
- **Internal joins use UUIDs**, never `shopify_*_id`. Shopify is being sunset.
- **All writes go through `createAdminClient()`** (service role). Never client-side.
- **Per-workspace credentials are encrypted** AES-256-GCM via `src/lib/crypto.ts`. Column names end with `_encrypted`.
- **AI responses are plain text, no markdown.** Max 2 sentences per paragraph. Mirror customer language.
- **User-facing names: `display_name` from `workspace_members`**, never full name.
- **Mini-site and live chat must produce identical ticket messages.** Only rendering differs.
- **`npx tsc --noEmit` before commits.** Migrations: `supabase/migrations/YYYYMMDDNNNNNN_description.sql`.
- **Don't push during active Inngest syncs** — Vercel deploy kills running functions.
- **Portal builds:** after editing `shopify-extension/portal-src/`, run `node scripts/build-all-portals.js`.
- **Customer-referenced tables:** when adding a `customer_id` column, add a Sonnet data tool in `sonnet-orchestrator-v2.ts`.
- **Journeys + cancel-flow + remedies + coupon mappings:** all DB-driven, never hardcoded.

## Next.js note

This is Next.js 16 (App Router). APIs and conventions may differ from training data — read `node_modules/next/dist/docs/` before writing new patterns.
