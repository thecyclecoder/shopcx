# inngest/marketing-text

SMS campaign send pipeline. textCampaignScheduled (create recipients + reserve shortlink + generate coupon) + textCampaignSendTick (5-min cron, sends pending recipients via Twilio).

**File:** `src/lib/inngest/marketing-text.ts`

## Functions

### `marketing-text-campaign-scheduled`
- **Trigger:** event `marketing/text-campaign.scheduled`
- **Concurrency:** `concurrency: [{ limit: 1 }]`


### `marketing-text-campaign-send-tick`
- **Trigger:** cron `* * * * *`
- **Retries:** 3
- **Concurrency:** `concurrency: [{ limit: 80 }]`

## Per-recipient shortlink format (REQUIRED) — `superfd.co/{LINKCODE}/{CUSTOMERCODE}`

The `{shortlink}` token in `message_body` expands **per recipient** to two segments, NOT one:

```
https://superfd.co/{slug}/{short_code}      e.g.  https://superfd.co/AB12CD/00059
                   └ link  └ customer
                     code    code
```

- **`{slug}`** = 6-char Crockford base32, one per campaign (the *link code*), reserved at schedule time on [[../tables/marketing_shortlinks]]. `buildShortlinkUrl` returns `https://{shortlink_domain}/{slug}` only.
- **`{short_code}`** = the recipient's `customers.short_code` (5 chars), appended by `send-tick` (`${shortlink_url}/${short_code}`). This is what makes clicks **attributable per user** — `/api/sl/[slug]` reads the trailing segment, resolves it to a customer, logs `Clicked SMS` on [[../tables/profile_events]], and sets the `sx_customer` cookie. **Without the customer code there is no per-user attribution** — never send a bare `superfd.co/{slug}`.
- A recipient missing a `short_code` is backfilled at send-tick; a bare link only ever happens for a non-customer phone (e.g. an ad-hoc test send) and should be treated as a broken test, not the real format.

## Message body formatting (REQUIRED) — line breaks, not a word blob

Compose `message_body` as **stacked blocks separated by a blank line (`\n\n`)**, mirroring how the copy is mocked — never one run-on paragraph. Canonical shape:

```
{hook — you were specially chosen}

{CTA label}
{shortlink}

{urgency line}
```

Each `\n` is one GSM-7 char; a blank line between blocks is `\n\n` (2 chars) — cheap, and it makes the SMS render as clean separated blocks on the phone instead of a wall of text. Keep the whole rendered message (incl. the ~31-char personal link) **GSM-7 only** (straight `'`, no emoji / curly quotes / em-dash) so it stays a single 160-char segment — any non-GSM-7 char drops the limit to 70 (UCS-2).

## Downstream events sent

- `marketing/sms-wave.promote`

## Tables written

- [[../tables/customers]]
- [[../tables/marketing_shortlinks]]
- [[../tables/profile_events]]
- [[../tables/sms_campaign_recipients]]
- [[../tables/sms_campaigns]]
- [[../tables/sms_send_candidates]]

## Tables read (not written)

- [[../tables/workspaces]]

## Related

Per-segment conversion from our own sends → [[../sms-segment-performance]].

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]] · [[../sms-segment-performance]]
