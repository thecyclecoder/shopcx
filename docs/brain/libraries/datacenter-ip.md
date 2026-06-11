# libraries/datacenter-ip

Classify a request IP as datacenter/crawler vs residential/mobile, for storefront bot exclusion.

**File:** `src/lib/datacenter-ip.ts`

## Why

Meta's ad-review crawlers hit storefront PDPs from Facebook data centers (AS32934 — Prineville, Luleå, Clonee, Forest City, Altoona, Fort Worth) on a scripted ~30s budget, spoofing real mobile browser UAs and auto-scrolling the page. So UA detection, engagement filtering, and city blocklists all fail or misfire (Fort Worth is both a Facebook DC and a real city). The only false-positive-safe signal is **network origin**: real shoppers come from residential/mobile ISPs, crawlers from datacenter networks.

## Exports

| Export | Purpose |
|---|---|
| `clientIpFromHeaders(headers)` | First IP of `x-forwarded-for`, else `x-real-ip`. On Vercel that's the real client IP. |
| `isDatacenterIp(ip)` | True if `ip` is in a bundled datacenter/Meta CIDR range. IPv4 only; IPv6 / malformed → `false` (treated as real — mobile carriers are real users, and we only ever flag IPs we positively know are datacenters). |

## Ranges

Bundled CIDR set: Meta/Facebook AS32934 edge ranges (the crawler that actually hits us) + a few large cloud blocks (AWS/GCP/Azure/DO/OVH/Hetzner/Linode). Conservative by design — a false positive deletes a real customer from the funnel. To extend, append CIDRs in the file; order doesn't matter.

## Privacy

Used by [[../inngest/..]] — actually `/api/pixel` — at ingestion: it classifies the IP and persists **only** [[../tables/storefront_sessions]].`is_bot`. The raw IP is never stored (the schema deliberately avoids IP PII). The funnel ([[../..]] `storefront-funnel` route) excludes `is_bot` sessions from every metric, alongside `is_internal`.

## Limitation

Cannot reclassify historical sessions (IPs were never stored). History is cleaned once via the behavioral crawler signature (auto-scroll chapter-bursts + scripted ~30s span); going forward, IP origin handles everything new.
