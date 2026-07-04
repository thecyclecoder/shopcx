# libraries/sms-marketing-policy-authoring

The **WRITE side** of [[../tables/sms_marketing_policy]] — the CMO-side mirror of the
Storefront Optimizer's policy-authoring. Iris (CMO) uses this to author + activate the
SMS Marketing Agent's bounded proxy. The agent + cron stay **read-only** over the
policy (see `loadSmsPolicy` in [[sms-marketing-agent]]); only Iris (or a human via a
future dashboard) writes here. Two halves of the activation leash: **author (off)**
then **activate (flip on)**.

**File:** `src/lib/sms-marketing-policy-authoring.ts` · Writes
[[../tables/sms_marketing_policy]] · Consumed by Iris's supervision lane + a future
`/dashboard/marketing/sms` control surface.

## Exports

### `authorSmsPolicy(admin, input)` → `Promise<AuthorSmsPolicyResult>`
Upsert the workspace's single policy row at the unique `(workspace_id)` key with
**`active=false`**. **Author-only — never flips the on-switch.** Idempotent at the
workspace grain. Stamps `created_by='agent'`. Optional `guardrails` are partial — any
field left undefined lets the column defaults fill it on upsert (weekly cap, min gap,
send windows, segment scope, theme wiring); carries the `rationale` (Iris's WHY).
Best-effort — returns `{ ok, policyId?, detail }`, never throws, so a lane that also
writes a [[../tables/director_activity]] audit line never loses it to an exception.

```ts
export interface AuthorSmsPolicyInput {
  workspaceId: string;
  guardrails?: SmsPolicyGuardrails; // { weekly_send_cap?, min_days_between_sends?, send_windows?, segment_scope?, theme_config? }
  rationale: string;
  createdBy?: string | null;        // an auth.users.id stamped on updated_by
}
```

### `activateSmsPolicy(admin, input)` → `Promise<ActivateSmsPolicyResult>`
Flip the workspace's policy `active=false → true` — the reversible on/off the next cron
tick re-reads. **Idempotent**: already-on ⇒ `{ ok:true, flipped:false }` (no-op).
**Fails if no row exists** (`{ ok:false, flipped:false }`) — call `authorSmsPolicy`
first. `flipped=true` iff this call performed the false→true transition.

```ts
export interface ActivateSmsPolicyInput { workspaceId: string; activatedBy?: string | null }
export interface ActivateSmsPolicyResult { ok: boolean; flipped: boolean; detail: string }
```

### Types
`SmsSendWindow` (`{ weekday, hour, theme }`), `SmsThemeOffer`
(`{ code, collection, discount_label }`), `SmsPolicyGuardrails` (all-optional editable
guardrails), `AuthorSmsPolicyInput` / `AuthorSmsPolicyResult`,
`ActivateSmsPolicyInput` / `ActivateSmsPolicyResult`.

## Callers

- Iris's (CMO) supervision lane — authors the policy + rationale, then activates.
- A future `/dashboard/marketing/sms` control surface (human-author path writes
  `created_by='human'`).

## Gotchas

- **Author never activates.** `authorSmsPolicy` always writes `active=false`; the
  on-switch is a separate, deliberate `activateSmsPolicy` flip — the two-switch
  dormancy of [[../tables/sms_marketing_policy]].
- **The engine never calls these** — it only reads (`loadSmsPolicy`). The engine
  writing its own policy would defeat supervisable autonomy (CLAUDE.md § North star).
- **Activate is guarded** — no row ⇒ fail (author first); already-on ⇒ idempotent
  no-op. Reversible: flipping back off is a plain policy edit.
- Best-effort, no throws — the typed result carries the failure `detail`.

---

[[../README]] · [[../../CLAUDE]] · [[../tables/sms_marketing_policy]] · [[sms-marketing-agent]] · [[../inngest/sms-marketing]] · [[../functions/cmo]]
