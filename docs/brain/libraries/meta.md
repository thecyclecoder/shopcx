# libraries/meta

Meta Graph + OAuth client. Auth URL builder, token mint, permission check, low-level Graph API wrapper.

**File:** `src/lib/meta.ts`

## Exports

### `verifyMetaWebhookSignature` — function

```ts
function verifyMetaWebhookSignature(rawBody: string, signatureHeader: string | null, appSecret: string | undefined,) : boolean
```

### `fetchMessengerUserProfile` — function

```ts
async function fetchMessengerUserProfile(pageAccessToken: string, psid: string,) : Promise<
```

### `sendMetaDM` — function

```ts
async function sendMetaDM(pageAccessToken: string, recipientId: string, message: string) : Promise<
```

### `replyToComment` — function

```ts
async function replyToComment(pageAccessToken: string, commentId: string, message: string, platform: "facebook" | "instagram" = "facebook",) : Promise<
```

### `hideComment` — function

```ts
async function hideComment(pageAccessToken: string, commentId: string, hide = true) : Promise<
```

### `deleteComment` — function

```ts
async function deleteComment(pageAccessToken: string, commentId: string) : Promise<
```

### `blockUserOnFbPage` — function

```ts
async function blockUserOnFbPage(pageAccessToken: string, pageId: string, appScopedUserId: string,) : Promise<
```

### `unblockUserOnFbPage` — function

```ts
async function unblockUserOnFbPage(pageAccessToken: string, pageId: string, appScopedUserId: string,) : Promise<
```

### `likeComment` — function

```ts
async function likeComment(pageAccessToken: string, commentId: string,) : Promise<
```

### `getPostMetadata` — function

```ts
async function getPostMetadata(pageAccessToken: string, postId: string,) : Promise<MetaPostMetadata | null>
```

### `getAdDestinationUrlsByMediaId` — function

```ts
async function getAdDestinationUrlsByMediaId(userAccessToken: string, mediaId: string, platform: "instagram" | "facebook",) : Promise<string[]>
```

### `getPageProfile` — function

```ts
async function getPageProfile(pageAccessToken: string) : Promise<
```

### `exchangeForPageTokens` — function

```ts
async function exchangeForPageTokens(appId: string, appSecret: string, shortLivedToken: string) : Promise<
```

### `subscribePageWebhooks` — function

```ts
async function subscribePageWebhooks(pageId: string, pageAccessToken: string) : Promise<
```

### `buildMetaAuthUrl` — function

```ts
function buildMetaAuthUrl(params: { appId: string; redirectUri: string; state: string; }) : string
```

### `exchangeMetaCode` — function

```ts
async function exchangeMetaCode(params: { appId: string; appSecret: string; code: string; redirectUri: string; }) : Promise<
```

### `MetaPostMetadata` — interface

### `ExchangedPage` — interface

## Callers

- `src/app/api/meta/auth/route.ts`
- `src/app/api/meta/callback/route.ts`
- `src/app/api/tickets/[id]/messages/route.ts`
- `src/app/api/webhooks/meta/route.ts`
- `src/lib/social-comment-actions.ts`
- `src/lib/social-comment-ingest.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
