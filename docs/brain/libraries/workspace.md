# libraries/workspace

Workspace helpers: `getWorkspace()`, `getWorkspaceById()`, `getCurrentWorkspace()`.

**File:** `src/lib/workspace.ts`

## Exports

### `getUserWorkspaces` — function

```ts
async function getUserWorkspaces(userId: string) : Promise<WorkspaceWithRole[]>
```

### `setActiveWorkspace` — function

```ts
async function setActiveWorkspace(userId: string, workspaceId: string)
```

### `getActiveWorkspaceId` — function

```ts
async function getActiveWorkspaceId() : Promise<string | null>
```

### `autoAcceptInvites` — function

```ts
async function autoAcceptInvites(userId: string, email: string)
```

## Callers

- `src/app/api/customers/[id]/enrich/route.ts`
- `src/app/api/customers/[id]/events/route.ts`
- `src/app/api/customers/[id]/links/route.ts`
- `src/app/api/customers/[id]/payment-methods/route.ts`
- `src/app/api/customers/[id]/route.ts`
- `src/app/api/customers/[id]/suggestions/route.ts`
- `src/app/api/customers/route.ts`
- `src/app/auth/callback/route.ts`
- `src/app/dashboard/layout.tsx`
- `src/app/workspace/select/actions.ts`
- `src/app/workspace/select/page.tsx`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
