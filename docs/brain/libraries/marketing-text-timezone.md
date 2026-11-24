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

### `isWithinSmsSendWindow` — function

```ts
function isWithinSmsSendWindow(instant: Date, timezone: string): boolean
```

The quiet-hours guard (TCPA). `true` ONLY when `timezone` is a valid IANA zone AND the recipient's local wall time at `instant` is `>= 09:00` and `< 20:00` (`SMS_WINDOW_START_HOUR` / `SMS_WINDOW_END_HOUR`). An invalid/unknown zone, or any instant outside the window, returns `false` — never throws. A caller that asserts this immediately before sending can never breach quiet hours regardless of how the send instant was computed.

### `isValidIanaTimezone` — function

```ts
function isValidIanaTimezone(timezone: string | null | undefined): boolean
```

`true` only for a real IANA zone (`Intl.DateTimeFormat` constructs without throwing). The guard that `getTimezoneOffsetMinutes`'s silent **0-for-unknown** (UTC-coercion) behaviour requires upstream of any send decision — validate BEFORE trusting an offset.

### `localDateKey` — function

```ts
function localDateKey(instant: Date, timezone: string): string | null
```

The recipient's LOCAL calendar date at `instant` as `'YYYY-MM-DD'` in `timezone` (null for an invalid zone). Used to anchor a send at an hour on the recipient's own date, not the UTC date.

### `SMS_WINDOW_START_HOUR` (9), `SMS_WINDOW_END_HOUR` (20) — constants

The inclusive start / exclusive end of the legal local send window (9:00 AM → 8:00 PM).

### `ResolvedTimezone` — interface

### `CustomerForTzResolve` — interface

### `TimezoneSource` — type

## Callers

- `src/lib/inngest/marketing-text.ts`
- `src/lib/pre-renewal-reminders.ts` (`planReminderSmsSend` uses `isValidIanaTimezone` + `localDateKey` + `isWithinSmsSendWindow` to schedule reminder texts only inside the 9 AM–8 PM local window)

## Gotchas

- **`getTimezoneOffsetMinutes` returns 0 (UTC) for an unknown zone** — it does NOT throw. A bad `customers.timezone` string therefore silently resolves to UTC, so any send gate MUST call `isValidIanaTimezone` first and never trust the offset for an unvalidated zone. This was a quiet-hours breach in the pre-renewal reminder (invalid zone ⇒ 11:00 UTC already past at the 13:00 UTC cron ⇒ immediate 8 AM Eastern text).
- **`resolveRecipientTimezone` never returns null** — on no data it returns `source:'fallback'` with the workspace default. A `fallback` source means the zone is a GUESS, not verified; a TCPA-sensitive send must treat `fallback` as "unknown" (email only), not as the recipient's real zone.

---

[[../README]] · [[../../CLAUDE]]
