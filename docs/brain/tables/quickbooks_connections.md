# quickbooks_connections

Per-workspace QuickBooks Online OAuth connection — the encrypted credentials [[../libraries/quickbooks]] uses to talk to QBO. Owner: [[../functions/cfo]] (Grace). One row per workspace.

The first row was **seeded by copying shoptics' live connection** (`scripts/_copy-qbo-connection-from-shoptics.ts`) rather than a fresh OAuth click — shoptics is the retiring logistics/finance engine and shopcx is taking over its QBO capability. All three secrets are AES-256-GCM encrypted via [[../libraries/crypto]].

**Primary key:** `id` · **Unique:** `(workspace_id)` — one connection per workspace.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE · UNIQUE |
| `realm_id` | `text` | NOT NULL · QBO Company ID — scopes every API path `/v3/company/{realm_id}/…` (Superfoods = `123146094168669`) |
| `environment` | `text` | NOT NULL · default `production` · picks the API host (`quickbooks.api.intuit.com` vs sandbox) |
| `refresh_token_encrypted` | `text` | NOT NULL · encrypted refresh token. **Rotates on every QBO refresh** — [[../libraries/quickbooks]] `getQboAccessToken` re-encrypts + re-persists it each time |
| `client_id_encrypted` | `text` | NOT NULL · encrypted Intuit app `client_id` |
| `client_secret_encrypted` | `text` | NOT NULL · encrypted Intuit app `client_secret` |
| `connected_at` | `timestamptz` | NOT NULL · default `now()` |
| `token_rotated_at` | `timestamptz?` | last time the refresh token rotated |
| `created_at` / `updated_at` | `timestamptz` | default `now()` |

**RLS:** service-role full access only (these are secrets — no workspace-member `SELECT`). All reads/writes via `createAdminClient()`.

## Gotchas

- **Refresh-token rotation is load-bearing.** Intuit issues a new refresh token on (almost) every refresh; drop it and the next call fails `invalid_grant`. `getQboAccessToken` persists it in one place — never re-implement the refresh inline.
- **Shared-token conflict with shoptics.** shopcx and shoptics use the *same* Intuit app + refresh token. Whichever refreshes last wins; the other's stored token eventually goes stale. This is the intended shoptics→shopcx handoff — shoptics' QBO cron should be retired so they don't fight. (Right after the initial copy, Intuit may return the *same* refresh token, so both briefly stay valid.)
- **App secrets stored per-connection (encrypted), not in env.** The brain's porting guide ([[../integrations/quickbooks-online]] §7) suggested env for the shared app creds; we chose encrypted per-connection so the setup is self-contained with no Vercel env changes. Either is fine.

## Related

[[qb_pnl_snapshots]] · [[workspaces]] · [[../libraries/quickbooks]] · [[../libraries/crypto]] · [[../integrations/quickbooks-online]] · [[../functions/cfo]]
