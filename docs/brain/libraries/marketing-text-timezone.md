# libraries/marketing-text-timezone

Resolution chain: customer tz → shipping zip → area code → workspace fallback. Drives per-recipient SMS send time.

**File:** `src/lib/marketing-text-timezone.ts`

## File header

```
Timezone resolver for SMS/MMS marketing campaigns.
Goal: given a customer record + a workspace fallback, return the
IANA timezone we should use when computing the recipient's send
time + which source got us there. Source is recorded on the
recipient row so we can audit how often each fallback fires and
harden the upstream data wherever the coverage is weakest.
Priority chain:
1. customers.timezone (explicit) — populated by the daily
customer-demographics enrichment job from shipping
address/zip. Highest confidence.
2. Derive from default_address.zip (US) via the `zipcodes`
package, then state → timezone. Catches anyone the
enrichment job hasn't run on yet.
3. Phone area code → state → timezone. Works for US numbers
with no address on file (e.g. lead-form-only customers
who gave phone but never bought). ~95% accurate; carriers
port numbers across regions so a Texas area code might
sit in Florida, but for marketing send-time purposes
"close to a Central/Mountain hour" is fine.
4. Workspace fallback. The campaign config carries its own
fallback_timezone column — if nothing else resolves, use
that. Default 'America/Chicago' for ShopCX.
Two things this resolver intentionally does NOT do:
- It doesn't call any external API. Resolution is local + fast
so we can batch through 100K recipients in a few seconds.
- It doesn't validate the timezone string against a master list.
IANA names from our state/area-code tables are correct by
construction; if someone manually writes a bad one into
customers.timezone we'll catch it the first time the cron
tries to build a Date with it and surface it as a recipient
status='failed' with a clear error.
```

## Exports

### `resolveRecipientTimezone` — function

```ts
function resolveRecipientTimezone(customer: CustomerForTzResolve | null | undefined, workspaceFallback: string,) : ResolvedTimezone
```

### `computeSendInstant` — function

```ts
function computeSendInstant(localDate: string, // 'YYYY-MM-DD' localHour: number, // 0-23 timezone: string, // IANA localMinute: number = 0, // 0-59 (defaults to top of the hour)) : Date
```

### `ResolvedTimezone` — interface

### `CustomerForTzResolve` — interface

### `TimezoneSource` — type

## Callers

- `src/lib/inngest/marketing-text.ts`

## Gotchas

_None documented._

---

[[../README]] · [[../../CLAUDE]]
