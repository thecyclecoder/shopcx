# error_feed_supabase_config

The single-row config for the Supabase Management Logs poller ([[../specs/error-feed-monitoring]] Phase 2): the owner's **encrypted access token** + the **poll cursor**. The lone owner-setup state for this spec — the token the [[../inngest/supabase-log-poll]] cron needs to pull DB-level errors via the [[../integrations/supabase-management-logs]] API (the service-role key we have is for data, not logs).

**Global infra, not workspace-scoped** (same as [[error_events]] / [[loop_heartbeats]]). **Single row**, `id = 'singleton'`.

**Primary key:** `id` (`text`, CHECK `id = 'singleton'`)

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `text` | PK · default `'singleton'` · CHECK `id = 'singleton'` — one row only |
| `access_token_encrypted` | `text?` | the owner's Supabase access token, AES-256-GCM ciphertext (`iv:tag:ciphertext` hex) via [[../libraries/crypto]]. **Null until the owner pastes it** ⇒ the poller is a no-op |
| `project_ref` | `text?` | the `<ref>` in `https://<ref>.supabase.co`. Null ⇒ derived from `NEXT_PUBLIC_SUPABASE_URL` at poll time; set only to override |
| `last_polled_at` | `timestamptz?` | poll cursor — the high-water timestamp of the last successful poll. The next poll asks the Logs API for `(last_polled_at, now]`, capped to 24h |
| `updated_at` | `timestamptz` | default `now()` |
| `created_at` | `timestamptz` | default `now()` |

## RLS

**Service-role only** — the row holds a secret, so (unlike [[error_events]]) there is **no authenticated SELECT** policy. The dashboard learns "configured?" through the owner API (`/api/developer/control-tower/supabase-token`, server-side admin read), never the raw token.

## Access helpers

`src/lib/control-tower/supabase-log-poll.ts`:
- `getSupabaseLogConfig(admin?)` → `{ token, projectRef, lastPolledAt }` (decrypted) or **null** when no token.
- `isSupabaseLogPollConfigured(admin?)` → boolean (what the owner UI reads).
- `setSupabaseAccessToken(token, { projectRef? }, admin?)` → encrypt + upsert.
- `clearSupabaseAccessToken(admin?)` → null the token (poller → no-op).

## Migration

`supabase/migrations/20260622160000_supabase_log_poll.sql` (this table + RLS, and widens the [[error_events]] `source` CHECK to admit `'supabase-logs'`) · apply: `scripts/apply-supabase-log-poll-migration.ts`

## Related

[[../specs/error-feed-monitoring]] · [[../inngest/supabase-log-poll]] · [[../integrations/supabase-management-logs]] · [[error_events]] · [[../libraries/control-tower]] · [[../libraries/crypto]]
