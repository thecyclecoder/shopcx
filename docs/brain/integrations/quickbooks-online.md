# QuickBooks Online (QBO) — integration skill set

> **Source of this doc:** reverse-engineered from the sibling repo `/Users/admin/Projects/shoptics`
> (Next.js 14 App Router + Supabase, single-tenant). Shoptics talks to QBO with **raw `fetch`** — no
> `intuit-oauth`, no `node-quickbooks` SDK. This page is the API/auth reference.
>
> **Status (2026-07-10): LIVE in shopcx** — the reusable core (per-workspace encrypted OAuth
> connection + one token manager + thin client) + the **ProfitAndLoss** pull shoptics never had,
> shipped as the CFO's P&L snapshotter + the **CFO → Financials** visual. A **Connect card**
> (Integrations → QuickBooks, `/api/qbo/*`) runs shopcx's own OAuth so it gets an **independent**
> refresh token (shoptics keeps its own — the two grants don't fight). The initial connection was
> also seeded by copying shoptics' live token. See [[../libraries/quickbooks]],
> [[../tables/qb_pnl_snapshots]], [[../tables/quickbooks_connections]], [[../functions/cfo]].
> **Prod activation:** set `QUICKBOOKS_CLIENT_ID/SECRET/ENVIRONMENT` in Vercel + register
> `${NEXT_PUBLIC_SITE_URL}/api/qbo/callback` in the Intuit app. Still to port: the inventory/COGS/
> month-end domain (Logistics — [[../functions/logistics]]).
>
> The "Porting to shopcx" section at the bottom maps every shoptics-ism onto shopcx conventions
> (multi-tenant, AES-256-GCM encrypted `_encrypted` columns via `src/lib/crypto.ts`).

---

## 0. TL;DR architecture

- **Auth:** OAuth 2.0 authorization-code grant. App-level `client_id`/`client_secret` (stored in a DB
  credentials row, NOT env). Per-company `refresh_token` + `realm_id` stored in a `qb_tokens` table.
  Access token (~1h) is never stored — derived on demand from the refresh token. Refresh token
  (~100 days) **rotates on every refresh** and must be re-persisted each time.
- **Client:** plain `fetch` against `https://quickbooks.api.intuit.com/v3/company/{realmId}/...`
  with `Authorization: Bearer`, `minorversion=65`, JSON Accept/Content-Type.
- **Entities read:** `Item` (Inventory + Group/BOM), `Account`, `Customer`, `Attachable` (item images).
- **Entities written:** `Item` (sparse cost/price update), `InventoryAdjustment`, `SalesReceipt`,
  `JournalEntry`.
- **Sync pattern:** **manual only** (a "Sync QuickBooks" button + a 7-step month-end close). No webhooks,
  no CDC, no cron. Pagination via `STARTPOSITION`/`MAXRESULTS`. Supabase `products`/`product_bom` mirror QBO items.
- **Production only** (sandbox base URL is wired but unused). Single QBO company (`realmId`).

---

## 1. Auth / OAuth 2.0

### 1.1 Endpoints / constants

| Purpose | URL | Where |
|---|---|---|
| Authorize (user consent) | `https://appcenter.intuit.com/connect/oauth2` | `src/app/api/qb/connect/route.ts:6` |
| Token (code→token, refresh) | `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` | many files, e.g. `quickbooks.ts:5` |
| Revoke | `https://developer.api.intuit.com/v2/oauth2/tokens/revoke` | `src/app/api/qb/disconnect/route.ts:5` |
| API base (prod) | `https://quickbooks.api.intuit.com` | `quickbooks.ts:111` |
| API base (sandbox) | `https://sandbox-quickbooks.api.intuit.com` | `quickbooks.ts:112` |

Scope requested: **`com.intuit.quickbooks.accounting`** only (no payments/payroll scope).

### 1.2 Connect flow — `GET /api/qb/connect` (`src/app/api/qb/connect/route.ts`)

```ts
const QB_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
export async function GET() {
  const creds = await getCredentials("quickbooks");           // app client_id/secret from DB
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://shoptics.ai";
  const params = new URLSearchParams({
    client_id: creds.client_id,
    response_type: "code",
    scope: "com.intuit.quickbooks.accounting",
    redirect_uri: `${baseUrl}/api/qb/callback`,
    state: crypto.randomUUID(),
  });
  return NextResponse.redirect(`${QB_AUTH_URL}?${params}`);
}
```

> **Gotcha (documented in shoptics CLAUDE.md):** the `redirect_uri` MUST be built from
> `NEXT_PUBLIC_SITE_URL` / a hard-coded prod domain — **never `request.url`** — because Vercel
> per-deploy URLs won't match the URI registered in the Intuit developer portal.
> The `state` UUID is generated but **not verified** on callback (a CSRF gap worth closing in shopcx).

### 1.3 Callback — `GET /api/qb/callback` (`src/app/api/qb/callback/route.ts`)

Intuit redirects back with `?code=...&realmId=...&state=...`. The route:
1. Reads `code` + `realmId` (`callback/route.ts:9-11`); 400 if either missing.
2. Exchanges code for tokens (Basic-auth header = base64 of `client_id:client_secret`):
   ```ts
   const basicAuth = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString("base64");
   await fetch(QB_TOKEN_URL, {
     method: "POST",
     headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
     body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${baseUrl}/api/qb/callback` }),
   });
   ```
3. Upserts the row (`callback/route.ts:49-54`):
   ```ts
   await supabase.from("qb_tokens").upsert({
     id: "current", refresh_token: tokens.refresh_token, realm_id: realmId, updated_at: ...,
   });
   ```
4. Redirects to `/dashboard/connections/quickbooks`.

**`realmId` is the QBO Company ID** — it scopes every API call (`/v3/company/{realmId}/...`) and is
captured *only* here, from the callback query param.

### 1.4 Disconnect — `POST /api/qb/disconnect` (`src/app/api/qb/disconnect/route.ts`)

POSTs the refresh token to the revoke endpoint, then deletes the `qb_tokens` row.
> **Gotcha:** must be **POST not GET** — Next.js prefetches `<a href>` and would silently revoke
> the connection (shoptics CLAUDE.md, line 348).

### 1.5 Token storage — `qb_tokens` table (`supabase/migrations/002_qb_tokens.sql`)

```sql
CREATE TABLE qb_tokens (
  id text PRIMARY KEY DEFAULT 'current',   -- single-tenant sentinel: always 'current'
  refresh_token text NOT NULL,             -- PLAINTEXT in shoptics
  realm_id text,                           -- QBO Company ID
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE qb_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role has full access to qb_tokens"
  ON qb_tokens FOR ALL TO service_role USING (true) WITH CHECK (true);
```

Notes:
- **Only the refresh token + realmId are persisted.** The access token is never stored — it's derived
  per process and cached in module memory (see refresh below).
- **`id = 'current'`** is a single-row sentinel because shoptics is single-tenant. shopcx needs this
  keyed by `workspace_id` instead.
- RLS allows only `service_role`; all reads/writes use `createServiceClient()` (service role). User-session
  clients can't touch it (CLAUDE.md line 345).
- shoptics stores the token **in plaintext**. shopcx convention: store `refresh_token_encrypted`,
  `realm_id` (realmId isn't secret), via `src/lib/crypto.ts`.

### 1.6 Refresh mechanism (the core lifecycle) — `quickbooks.ts:8-106`

Access tokens last ~1h; refresh tokens last ~100 days and **rotate on every use** (Intuit returns a new
`refresh_token` each refresh). shoptics handles this with a module-level in-memory access-token cache and
a DB-persisted refresh token:

```ts
let cachedToken: { access_token: string; expires_at: number } | null = null;   // quickbooks.ts:8

async function getAccessToken(): Promise<string> {
  // serve from cache if >60s of life left
  if (cachedToken && Date.now() < cachedToken.expires_at - 60_000) return cachedToken.access_token;

  const { refresh_token } = await getStoredTokens();              // read qb_tokens
  if (!refresh_token) throw new Error("No QB refresh token...");

  const creds = await getCredentials("quickbooks");
  const basicAuth = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString("base64");
  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basicAuth}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token }),
  });
  if (!res.ok) throw new Error(`QB token refresh failed (${res.status})...`);
  const data = await res.json();

  cachedToken = { access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 };

  // QB issues a NEW refresh token on every refresh — store it
  if (data.refresh_token) await storeRefreshToken(data.refresh_token);   // quickbooks.ts:101-103
  return data.access_token;
}
```

`storeRefreshToken` (`quickbooks.ts:30-54`) re-reads `realm_id` first and upserts it back so the rotation
write never clobbers the realmId. `getRealmAndToken()` (`quickbooks.ts:245-253`) combines a fresh access
token with the stored `realm_id` (falling back to `process.env.QB_REALM_ID`).

> **Critical invariant:** every code path that refreshes the token MUST persist the returned
> `data.refresh_token`. If you refresh and drop the new one, the next refresh fails with `invalid_grant`
> and the user has to re-authorize. Several routes duplicate this inline (see §1.7).

### 1.7 ⚠️ Duplicated refresh logic (an anti-pattern to consolidate)

The clean `getAccessToken()` cache lives in `quickbooks.ts`, but several API routes **bypass it** and
re-implement refresh inline with direct PostgREST calls (so they can avoid the Supabase JS client's
caching). Each one: reads `qb_tokens` via REST → POSTs refresh → PATCHes the rotated token back.

- `journal-entry/route.ts:86-108`
- `sales-receipt/route.ts:140-184`
- `account-mappings/route.ts:159-193`
- `revenue-accounts/route.ts:14-48`
- `month-end-closing/route.ts:20-45` (`getQBToken()` helper)

> In shopcx, build ONE token manager (per-workspace) and have every route call it. Do not copy the
> shoptics duplication.

---

## 2. API client

There is no client class — just helper functions in `src/lib/integrations/quickbooks.ts` plus inline
`fetch` in routes. Pattern for every authenticated request:

```ts
const res = await fetch(
  `${baseUrl}/v3/company/${realmId}/{path}?minorversion=65`,
  {
    method: "POST" | "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",   // writes only
      Accept: "application/json",
    },
    body: JSON.stringify(payload),          // writes only
  }
);
if (!res.ok) throw new Error(`QB ... failed: ${res.status} ${await res.text()}`);
const data = await res.json();
```

- **Base URL** chosen by `baseUrl()` (`quickbooks.ts:108-113`) off `creds.environment === "production"`.
- **`minorversion=65`** pinned on essentially every call (query string param).
- **Auth:** `Authorization: Bearer <accessToken>` for API calls; `Authorization: Basic <base64(id:secret)>`
  for the token/revoke endpoints.
- **Query endpoint** is GET: `/v3/company/{realmId}/query?query=<URL-encoded SQL>`.
- **Create/update endpoints** are POST to the lowercase entity name: `.../item`, `.../journalentry`,
  `.../salesreceipt`, `.../inventoryadjustment`.

### Retry / rate-limit / 401 handling

- **No retry, no backoff, no 429 handling** anywhere. Errors throw with the response body.
- **No explicit 401-refresh-retry loop.** Instead the cache refreshes proactively when <60s of life
  remains (`quickbooks.ts:57`), so a 401 mid-flight isn't caught — it just throws.
- Image fetch loop (`fetchItemImages`) swallows per-item failures (`continue` / try-catch) rather than
  retrying (`quickbooks.ts:176`, `212`).

> shopcx should add: 429/`ThrottleExceeded` exponential backoff, and a one-shot "401 → force refresh →
> retry once" wrapper. QBO throttle limit is ~500 req/min/realm and a small concurrent-request cap.

### Helper function signatures (`src/lib/integrations/quickbooks.ts`)

| Function | Signature | Purpose |
|---|---|---|
| `updateItem` | `(itemId: string, updates: Record<string,any>) => Promise<QBItem>` (`:115`) | Sparse-ish update: fetch full item, merge, POST back |
| `fetchItemImages` | `(itemIds: string[]) => Promise<Map<string,string>>` (`:150`) | Query `Attachable`, download `TempDownloadUri`, resize→webp→Supabase Storage |
| `fetchItemById` | `(token, realmId, itemId: string) => Promise<QBItem>` (`:295`) | GET single item |
| `fetchInventoryItems` | `() => Promise<QBItem[]>` (`:319`) | All `Type='Inventory'` items |
| `fetchGroupItems` | `() => Promise<QBItem[]>` (`:324`) | All `Type='Group'`, then full-fetch each for BOM lines |
| `fetchAllItems` | `() => Promise<{inventory: QBItem[]; groups: QBItem[]}>` (`:338`) | Both, in parallel + per-group detail fetch |
| `queryItems` (private) | `(token, realmId, typeFilter: string) => Promise<QBItem[]>` (`:255`) | Paginated `SELECT * FROM Item WHERE Type=...` |

`QBItem` interface (`quickbooks.ts:228-243`): `Id, Name, Sku?, Type, QtyOnHand?, UnitPrice?, PurchaseCost?,
SyncToken?, Active, ItemGroupDetail?.ItemGroupLine[]` (plus `[key:string]:any`).

---

## 3. Entities & operations

### 3.1 Query language

QBO uses a SQL-ish language at `GET /v3/company/{realmId}/query?query=<encoded>`. Response shape is
`{ QueryResponse: { <EntityName>: [...] } }`. Examples used in shoptics:

```sql
-- paginated item sync (quickbooks.ts:266)
SELECT * FROM Item WHERE Type = 'Inventory' STARTPOSITION 1 MAXRESULTS 1000

-- item images via Attachable, IN-list of item ids (quickbooks.ts:163)
SELECT * FROM Attachable
WHERE AttachableRef.EntityRef.Type = 'Item'
  AND AttachableRef.EntityRef.value IN ('12','13',...) MAXRESULTS 1000

-- account pickers by type (account-mappings/route.ts:205-209)
SELECT Id, Name, FullyQualifiedName, AccountType FROM Account
WHERE AccountType IN ('Expense','Cost of Goods Sold') MAXRESULTS 200
SELECT Id, DisplayName FROM Customer MAXRESULTS 200

-- revenue accounts, then filtered in JS by AccountSubType (revenue-accounts/route.ts:51)
SELECT Id, Name, AccountType, AccountSubType FROM Account
WHERE AccountType = 'Income' MAXRESULTS 100
```

> Filtering by `AccountSubType` is done **client-side in JS** (`revenue-accounts/route.ts:68-71`,
> keeping `SalesOfProductIncome` / `OtherPrimaryIncome`) rather than in the WHERE clause.

### 3.2 `Item` — read (catalog/cost/inventory mirror)

Two `Type`s matter:
- **`Inventory`** — finished goods / components. Carries `QtyOnHand`, `UnitPrice`, `PurchaseCost`.
- **`Group`** — a BOM (bill of materials / "bundle"). The list query returns it sparse; you must
  GET the item by Id to populate `ItemGroupDetail.ItemGroupLine[]` (each line = `{ItemRef:{value,name,type}, Qty}`).
  See `fetchGroupItems` (`quickbooks.ts:324-336`) and `fetchAllItems` (`:338-356`).

Consumed by `syncQBProducts()` (`src/lib/sync-engine.ts:76`):
- Upserts `products` on `quickbooks_id` with `quickbooks_name`, `unit_cost = item.PurchaseCost`,
  qty, etc. (`sync-engine.ts:94-104`, `143-153`).
- For each Group line, links components to the parent in legacy `products.bundle_id` **and** the
  many-to-many `product_bom` table (`sync-engine.ts:170-200`).

### 3.3 `Item` — write (sparse update) — `updateItem` (`quickbooks.ts:115-148`)

QBO has **no PATCH**. To update, you POST the *full* object back. shoptics does a read-modify-write:

```ts
const current = await fetchItemById(token, realmId, itemId);  // full object incl. SyncToken
const merged = { ...current, ...updates };
await fetch(`${baseUrl}/v3/company/${realmId}/item?minorversion=65`, {
  method: "POST", headers: {Bearer, json}, body: JSON.stringify(merged),
});
```

Because `current` already contains the live `SyncToken`, the update carries the correct token. (For
true "sparse update" QBO also accepts `sparse: true` + only changed fields + `Id` + `SyncToken`, but
shoptics uses the full-merge approach.)

### 3.4 `JournalEntry` — create/update (the Shopify monthly JE)

`src/app/api/qb/journal-entry/route.ts`. `GET` previews (`buildJournalEntryData`), `POST` writes.

Payload shape (`journal-entry/route.ts:76-84`, `121-126`):
```ts
const qbLines = data.lines.map(line => ({
  Amount: Math.round(line.amount * 100) / 100,
  DetailType: "JournalEntryLineDetail",
  Description: line.description,
  JournalEntryLineDetail: {
    PostingType: line.postingType,                 // "Debit" | "Credit"
    AccountRef: { value: line.accountId, name: line.accountName },
  },
}));
const jePayload = { DocNumber: `SHOPIFY-${mo}${yy}`, TxnDate, PrivateNote, Line: qbLines };
```

Create vs update (`:128-141`): if a `shopify_journal_entry_id` already exists for that month
(`month_end_closings`), it GETs the existing JE to read its **`SyncToken`**, sets `jePayload.Id` +
`jePayload.SyncToken`, and POSTs to the same `/journalentry` endpoint (QBO uses the presence of
`Id`+`SyncToken` to switch create→update). Both paths POST to
`/v3/company/{realmId}/journalentry?minorversion=65`.

Business logic worth knowing: debits must equal credits (validated `±0.01`, `:59-65`); a rounding
adjustment line ≤ $1 auto-balances (`:519-542`). Revenue is grouped by each product's mapped QBO
income account; processor gross/fees/refunds/chargebacks come from `payment_processor_summaries`.

### 3.5 `SalesReceipt` — create (COGS via Group auto-expansion)

`src/app/api/qb/sales-receipt/route.ts`. A **$0** sales receipt whose only purpose is to make QBO
relieve inventory and post COGS for the month's units. Two line shapes (`:113-133`):

```ts
// Group/bundle item — QBO auto-expands the BOM for COGS
{ DetailType: "GroupLineDetail",
  GroupLineDetail: { GroupItemRef: { value: product.quickbooks_id }, Quantity: units } }

// Plain inventory item
{ DetailType: "SalesItemLineDetail", Amount: 0,
  SalesItemLineDetail: { ItemRef: { value: product.quickbooks_id }, Qty: units, UnitPrice: 0 } }
```

Receipt body (`:200-207`): `{ DocNumber: "AMZ-MM-YYYY"|"SHOP-MM-YYYY", TxnDate, CustomerRef:{value},
DepositToAccountRef:{value}, PrivateNote, Line }` → POST `/v3/company/{realmId}/salesreceipt?minorversion=65`.
`CustomerRef`/`DepositToAccountRef` values come from `qb_account_mappings` (§3.7).

### 3.6 `InventoryAdjustment` — create (zero out variances)

`src/app/api/qb/month-end-closing/route.ts:206-219`. Posts whole-number quantity deltas to a shrinkage
expense account:
```ts
const adjBody = {
  TxnDate,
  AdjustAccountRef: { value: shrinkageAcctId },
  Line: adjLines,   // each: { DetailType:"ItemAdjustmentLineDetail",
                    //         ItemAdjustmentLineDetail:{ ItemRef:{value}, QtyDiff: <int> } }
};
// POST /v3/company/{realmId}/inventoryadjustment?minorversion=65
```
> `QtyDiff` is rounded to an integer (`Math.round(comp.variance)`, `:170`) — QBO inventory quantities
> are integers; fractional BOM multipliers (e.g. ×0.2) would otherwise produce decimals.

### 3.7 `Account` & `Customer` — read (for mapping pickers)

`account-mappings/route.ts:204-221` fetches 5 account/customer buckets in parallel and returns
`{id, name(=FullyQualifiedName), type}`. These populate searchable dropdowns in the QB Connections UI;
the chosen `{qb_id, qb_name}` is saved to `qb_account_mappings` (§4.2). `revenue-accounts/route.ts`
does the same for income accounts → saved onto `products.revenue_account_id/_name`.

### 3.8 Entities NOT used

No `Vendor`, `Bill`, `PurchaseOrder`, `Payment`, `Invoice`, `CompanyInfo`, `Preferences`, no **CDC**
(`/cdc` change-data-capture), no **webhooks**, no **batch** endpoint. (Confirmed: zero matches for
`cdc|changedatacapture|webhook` in the QBO code.)

### 3.9 Entity-reference shapes (cheat sheet)

- Account/Customer/Item ref in a line: `{ value: "<Id>", name?: "<display>" }`
- Group line (BOM): `ItemRef: { value, name, type }`, sibling `Qty`
- JE line ref: `AccountRef: { value, name }` inside `JournalEntryLineDetail`
- Amounts: 2-decimal numbers (`Math.round(n*100)/100`). QBO stores currency; cents matter.
- Every fetched entity carries `Id` + `SyncToken` (string, increments on each edit).

---

## 4. Sync architecture

### 4.1 Triggers — manual only

- **Catalog/cost/inventory sync** (`syncQBProducts`) is the one "Sync QuickBooks" button; explicitly
  **excluded from `syncAll()`/cron** (shoptics CLAUDE.md §Sync Engine). Run at month-end.
- **Month-end close** is a user-triggered `POST /api/qb/month-end-closing` (7 steps, §4.4). Has a date
  guard: refuses to run before the 1st of the following month unless `?debug=true` (`route.ts:73-78`).
- No webhooks, no CDC, no scheduled QBO sync.

### 4.2 Supabase mirror + mapping tables

| Table | Role | Key columns |
|---|---|---|
| `qb_tokens` | OAuth state | `id='current'`, `refresh_token`, `realm_id` |
| `products` | mirror of QBO items | `quickbooks_id UNIQUE NOT NULL`, `quickbooks_name`, `unit_cost`, `item_type`, `bundle_id`, `revenue_account_id`, `revenue_account_name` |
| `product_bom` | many-to-many BOM (Group→component) | parent/child product ids, qty |
| `qb_account_mappings` | role→QBO entity id | `key PK`, `qb_id`, `qb_name` |
| `month_end_closings` | per-month run state + written-doc ids | `closing_month`, `status`, `*_receipt_id`, `inventory_adjustment_id`, `shopify_journal_entry_id`, `variance_*` |
| `payment_processor_summaries` | JE inputs | `closing_month`, `processor`, gross/fees/refunds/chargebacks |
| `gateway_mappings` | Shopify gateway → processor bucket | `gateway_name`, `processor` |

`products` migration: `001_initial_schema.sql:10-11` (`quickbooks_id`/`quickbooks_name`, unique +
indexed `idx_products_qb_id`). Revenue columns: `020_product_revenue_account.sql`.
`qb_account_mappings`: `023_qb_account_mappings.sql` (`key/qb_id/qb_name`).

### 4.3 Pagination & incremental sync

- Pagination is `STARTPOSITION` (1-based) + `MAXRESULTS` (1000 for items), loop until a page returns
  `< MAXRESULTS` (`quickbooks.ts:264-290`).
- **No incremental/delta sync.** Every catalog sync is a full pull + upsert. Idempotency comes purely
  from `upsert(..., { onConflict: "quickbooks_id" })`. (`product_bom` similarly upserted.)
- Month-end idempotency: a `month_end_closings` row per `closing_month` with `status` guards re-runs
  (`completed` → refuse, `route.ts:87-92`); JE/receipt ids stored so re-runs update rather than duplicate.

### 4.4 Month-end close — the orchestration (`month-end-closing/route.ts`)

Single POST runs 7 sequential steps, each recording a `StepResult`, writing ids back to
`month_end_closings`, and re-fetching a fresh QBO token between steps that consume time:

1. **Pre-snapshot** QBO inventory → `inventory_snapshots` (`route.ts:111-134`).
2. **InventoryAdjustment** to zero variances vs FBA+3PL+Manual (`:136-233`).
3. **Amazon SalesReceipt** ($0, COGS) — calls `/api/qb/sales-receipt` (`:235-259`).
4. **Shopify SalesReceipt** — same (`:261-283`).
5. **Post-snapshot** inventory (`:285-311`).
6. **Variance check** post-QBO vs channels (must be zero) (`:313-377`).
7. **Sync processors then create/update Shopify JournalEntry** (`:379-411`).

> It forwards both `cookie` and `authorization` headers to its sub-fetches so internal API calls pass
> middleware auth whether triggered from the UI session or a `CRON_SECRET` bearer (`route.ts:65-71`).

---

## 5. Gotchas (carry these into shopcx)

1. **`minorversion=65` pinned everywhere.** Omitting it changes default behavior/field availability.
   Pin one version and bump deliberately.
2. **Refresh-token rotation.** Every refresh returns a new `refresh_token`; persist it immediately or
   the next call breaks with `invalid_grant`. shoptics re-persists in 6 different places — consolidate.
3. **No PATCH / SyncToken conflicts.** Updates require the current `SyncToken`; always GET-then-write
   (Item) or GET-the-existing-id (JE). A stale token → QBO `Stale Object Error`.
4. **No rate-limit handling.** ~500 req/min/realm + low concurrency cap. The per-group "fetch full item"
   loop and the per-item `products` lookups in month-end can burst — add throttling/backoff in shopcx.
5. **Token-expiry edge cases.** Access token cached in module memory with a 60s safety margin; serverless
   cold starts re-derive it. There's no 401-retry, so a token expiring mid-request just errors.
6. **realmId scoping.** It's the company id in every path. Single value in shoptics; in shopcx it's
   per-workspace and must travel with the token.
7. **Sandbox vs prod.** Two different base hosts; the token/authorize/revoke hosts are the **same** for
   both. shoptics only ever runs `production`.
8. **Decimal/penny handling.** Money rounded `Math.round(n*100)/100`; JE must balance to `±0.01` with a
   ≤$1 rounding line. Inventory `QtyDiff` rounded to integers.
9. **Entity ref shape is `{value, name}`** (id is `value`, not `id`). Group lines also carry `type`.
10. **`Attachable` image URLs (`TempDownloadUri`) expire** — shoptics downloads + re-hosts to Supabase
    Storage as 400×400 webp immediately (`quickbooks.ts:188-211`).
11. **redirect_uri must be the registered prod URL**, not `request.url` (Vercel deploy URLs differ).
12. **Disconnect must be POST** (prefetch would revoke).
13. **`state` is generated but not validated** on callback — add CSRF verification in shopcx.
14. **Supabase boolean filter quirk** (shoptics-specific): `.eq("active", true)` returned 0 rows on
    Vercel; they filter `active` in JS. Verify whether this affects shopcx's Postgres setup.

---

## 6. Env vars / config (NAMES only)

shoptics keeps **app-level QBO secrets in the DB**, not env. The only QBO-relevant env names:

- `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — service-role DB access for token rows.
- `NEXT_PUBLIC_SITE_URL` — base for the OAuth `redirect_uri` (falls back to a hard-coded prod domain).
- `QB_REALM_ID` — optional fallback realmId (`quickbooks.ts:248`); normally read from `qb_tokens`.
- `CRON_SECRET` / `PUSH_SECRET` — auth for internal calls / notifications (not QBO-specific).

Per-company QBO secrets live in DB rows:
- App `client_id` + `client_secret` + `environment` → `integration_credentials` row id `quickbooks`
  (jsonb `credentials`), read via `getCredentials("quickbooks")` (`src/lib/credentials.ts:8`).
- `refresh_token` + `realm_id` → `qb_tokens`.

> In shopcx these become **per-workspace encrypted** values (see §7), not a single shared row.

---

## 7. Porting to shopcx

shopcx is multi-tenant with AES-256-GCM per-workspace creds (`src/lib/crypto.ts`, `_encrypted` columns)
and all writes through `createAdminClient()`. The shoptics single-tenant `id='current'` model does not
carry over. Smallest viable surface:

### 7.1 Tables (one migration, `supabase/migrations/YYYYMMDDNNNNNN_quickbooks.sql`)

- `quickbooks_connections` (per workspace):
  `workspace_id` (FK), `realm_id` text, `refresh_token_encrypted` text, `environment` text
  (`production`/`sandbox`), `connected_at`, `updated_at`. RLS scoped to the workspace; writes via admin client.
  Store the app `client_id`/`client_secret` either as workspace creds (`*_encrypted`) or as a shared app
  secret in env — QBO apps are usually one set of app creds across all companies, so a single
  `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` env pair + per-workspace `realm_id`/`refresh_token_encrypted`
  is the cleanest split.
- Mirror/mapping tables only if you need them: a `quickbooks_account_mappings` (workspace_id, key,
  qb_id, qb_name) mirrors `qb_account_mappings`. Product mirroring (`products`/`product_bom`) is
  shoptics-domain (inventory) and likely **does not** carry to shopcx's retention domain — skip unless
  shopcx grows an accounting/COGS feature.

### 7.2 One token manager (`src/lib/quickbooks.ts`)

Replace the 6 inline refresh copies with a single function:
```ts
async function getQboAccessToken(workspaceId: string): Promise<{ token: string; realmId: string }>
```
- Read `quickbooks_connections` for the workspace via `createAdminClient()`.
- Decrypt `refresh_token_encrypted` with `src/lib/crypto.ts`.
- POST refresh to `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer` with Basic auth
  (app client id/secret). Cache the access token keyed by `workspaceId` (a `Map`, with the same 60s margin).
- **Re-encrypt and persist the rotated `refresh_token`** every time. Wrap in a "401 → force refresh →
  retry once" + 429 backoff helper (shoptics lacks both).

### 7.3 Connect/callback/disconnect routes

Port `connect`/`callback`/`disconnect` nearly verbatim, but:
- Carry `workspace_id` through `state` (and **validate** state on callback — shoptics doesn't).
- `redirect_uri` from a shopcx site-url env, registered in the Intuit dev portal.
- Upsert into `quickbooks_connections` keyed by `workspace_id`, encrypting the refresh token.

### 7.4 Thin API client

A single `qboFetch(workspaceId, { method, path, query, body })` that injects
`/v3/company/{realmId}/{path}?minorversion=65`, the Bearer header, and JSON headers — plus the
refresh/backoff wrapper. Add `qboQuery(workspaceId, sql)` for the query endpoint. Everything in §3
(`Item`, `JournalEntry`, `SalesReceipt`, `InventoryAdjustment`, `Account`, `Customer`) is just a payload
on top of that.

### 7.5 shoptics assumptions that do NOT carry over

- Single tenant / `id='current'` sentinel → per-workspace rows.
- Plaintext refresh token → `_encrypted` via `crypto.ts`.
- App secrets in `integration_credentials` jsonb → env (shared app) + per-workspace connection row.
- Production-only / single realmId → multiple realmIds, one per workspace.
- The whole inventory/COGS/month-end domain (`products`, `product_bom`, sales receipts, inventory
  adjustments, A2X/Amazon/3PL variance logic) is shoptics' accounting product; shopcx would only need it
  if it adds accounting features. The **reusable core** is auth + token rotation + the thin client + the
  query/entity patterns.
- No webhooks/CDC in shoptics; if shopcx wants near-real-time it would need to add Intuit webhooks
  (subscribe in the dev portal, verify the `intuit-signature` HMAC) — not present to copy.

### 7.6 Brain hygiene (shopcx rule)

When implemented, add: a `tables/quickbooks-connections.md` page, a `libraries/quickbooks.md` page, and
fold this integration page's "live" state into the relevant lifecycle. Add a Sonnet data tool only if a
`customer_id`-referenced QBO table is introduced.
