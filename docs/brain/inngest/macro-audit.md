# inngest/macro-audit

Periodic audit of macro acceptance rates. Flags low-performing macros for admin review.

**File:** `src/lib/inngest/macro-audit.ts`

## Functions

### `macro-audit`
- **Trigger:** event `macro-audit/start`
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1, key: "event.data.workspace_id" }]`


## Downstream events sent

_None._

## Tables written

- [[../tables/macro_audit_jobs]]

## Tables read (not written)

- [[../tables/macros]]
- [[../tables/product_intelligence]]

## Header notes

```
Inngest function: audit macros against product intelligence
Processes macros one by one, updating progress in macro_audit_jobs table
```

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
