# Worktree: Bulk Ticket Actions

## Setup
```bash
cd /Users/admin/Projects/shopcx
git worktree add ../shopcx-bulk-actions feature/bulk-actions
cd ../shopcx-bulk-actions
npm install
```

Work in `/Users/admin/Projects/shopcx-bulk-actions` — NOT main.

## What to Build

Agents need to select multiple tickets from the ticket queue and perform bulk actions: close, assign, tag, change status.

## API Endpoint

### `src/app/api/tickets/bulk/route.ts`

POST endpoint for bulk operations.

```typescript
// Body shape
{
  ticket_ids: string[];
  action: 'close' | 'assign' | 'add_tag' | 'remove_tag' | 'set_status' | 'delete';
  value?: string; // assignee user_id, tag name, or status
}
```

- Auth: workspace member
- For delete: require admin/owner role
- Max 100 tickets per request
- Returns `{ updated: number, errors: string[] }`
- All updates use `createAdminClient()`

Implementation:
```typescript
switch (action) {
  case 'close':
    await admin.from("tickets").update({ status: "closed", resolved_at: new Date().toISOString() })
      .in("id", ticket_ids).eq("workspace_id", workspaceId);
    break;
  case 'assign':
    await admin.from("tickets").update({ assigned_to: value })
      .in("id", ticket_ids).eq("workspace_id", workspaceId);
    break;
  case 'add_tag':
    // For each ticket, append tag to existing tags array
    // Supabase doesn't support array_append in bulk, so loop
    break;
  case 'remove_tag':
    // Similar, array_remove
    break;
  case 'set_status':
    await admin.from("tickets").update({ status: value })
      .in("id", ticket_ids).eq("workspace_id", workspaceId);
    break;
  case 'delete':
    // Delete messages first, then tickets
    break;
}
```

## UI Changes (`src/app/dashboard/tickets/page.tsx`)

### Multi-Select Mode

1. **Checkbox column** — Add a checkbox to each ticket row (left side)
   - Header checkbox selects/deselects all visible tickets
   - Individual checkboxes per row

2. **Selection state** — `useState<Set<string>>` for selected ticket IDs

3. **Bulk action bar** — Appears when 1+ tickets selected. Sticky bar at top:
   ```
   [X selected] [Close] [Assign ▾] [Tag ▾] [Status ▾] [Delete] [Clear]
   ```
   - Close: immediately closes all selected
   - Assign: dropdown of workspace members
   - Tag: dropdown with existing tags + text input for new
   - Status: dropdown (open, pending, closed)
   - Delete: confirm dialog, admin/owner only
   - Clear: deselects all

4. **Visual feedback**:
   - Selected rows have light indigo background
   - Count updates as you select
   - After action: clear selection, refresh list
   - Show toast/alert: "12 tickets closed"

### Key Interactions
- Shift+click to select range
- Escape to clear selection
- Actions are immediate (no confirm except delete)

## Files to Create
- `src/app/api/tickets/bulk/route.ts` — Bulk action API
- Modify `src/app/dashboard/tickets/page.tsx` — Add checkboxes + action bar

## Database Changes
None needed.

## Architecture Notes
- Tags are stored as `TEXT[]` on tickets. For bulk tag add/remove, you need to fetch each ticket's current tags, modify, and update. Or use a raw SQL function:
  ```sql
  UPDATE tickets SET tags = array_append(tags, 'new-tag') WHERE id = ANY($1)
  ```
  Consider creating an RPC for this.
- Keep the selection in client state only — don't persist it
- The ticket list already polls every 10s; after bulk action, force a refresh

## Testing
1. Select 3 tickets → bulk close → verify all closed
2. Select 5 tickets → bulk assign to a member → verify
3. Select 2 tickets → add tag "test-bulk" → verify tags added
4. Shift-click range selection works
5. Select all checkbox works

## When Done
Push to `feature/bulk-actions` branch. Tell the merge manager (main terminal) to merge.
