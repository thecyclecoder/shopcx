# libraries/customer-find

Locate a customer from identifiers they supply **in the conversation** — name, street address, phone, an alternate email — rather than from an existing record.

**File:** `src/lib/customer-find.ts` · **Test:** `src/lib/customer-find.test.ts` (`npm run test:customer-find`) · **Exposed as:** the `find_customer` tool in [[sonnet-orchestrator]] · **Grading reused from:** [[account-matching]]

## Why it exists

All 14 of the orchestrator's data tools assume the customer is **already identified** — `get_customer_account`, `get_customer_timeline`, `get_returns` each take a `customerId`. **None could find one.** So when an inbound email didn't resolve to an account, the orchestrator's only legal move was to escalate.

Ticket `879dd36b` (2026-08-12) is the ground truth. Mark McCartney wrote in to cancel and request a refund; his email matched nothing. The orchestrator escalated while narrating the search it could not perform:

> *"Since we can't locate their account by email, this needs a human agent to search by name/address."*

He had already given us his full name, street address and phone. Nothing searched any of them.

Two customer-facing failures rode on that gap:

1. **It promised a remedy it could not verify** — *"cancelling your deliveries and processing your refund are both things we can absolutely take care of"* — to a person it could not identify. Per [[../tables/policies]], that refund may well have been ineligible: renewals are categorically denied, MBG is first-order-only, and returns are one-per-customer-lifetime.
2. **It fabricated a verification** — *"I can see from your address that you've been receiving shipments from us"* — in the **same turn** as an internal note reading *"There are no orders or subscriptions visible."* There were none: zero orders to that ZIP under that name, zero phone matches.

## Why not `account-matching.findUnlinkedMatches`

That answers a different question — *"which other records look like this **existing** customer?"* — and reads identity fields off a populated `customers` row. In the failing case the row was a **stub the ticket minted 35ms earlier** (email only; `first_name`, `phone`, `default_address` all null), so it had nothing to match *on*. This module takes the identifiers as **arguments**, which is the shape a conversation actually provides.

## Exports

- `findCustomerByIdentifiers(admin, workspaceId, { name?, email?, phone?, address1?, zip? })` → `{ matches, searched, searchable }`
- `findCustomerToText(result)` — the orchestrator-facing rendering
- `phoneKey(v)` — trailing-10-digit key, so `+1 612 388 1773` / `(612) 388-1773` / `6123881773` compare equal
- `surnameOf(name)` — last token, lowercased

One indexed query per supplied signal (mirroring `findUnlinkedMatches`' branch shape), merged in memory. **Address is searched directly**, not only used to corroborate a name — a spouse or gift-giver ordering under a different surname is exactly the case an email lookup misses, and exactly the failing case.

**Grading is not re-implemented.** Candidates go through the same pure `gradeUnlinkedCandidates` the linking flow uses, so `high` means the same thing on both surfaces (a shared address corroborating a surname, **or** a shared phone) and the two can never drift.

## `searchable` is the load-bearing field

`searchable:false` (no usable identifier) is **not** the same as `matches:[]` (searched, found nobody) — and the rendering keeps them apart:

| State | What the agent is told |
|---|---|
| `searchable:false` | *"nothing was searched … Do NOT state or imply that no account exists; you have not looked."* |
| `matches: []` | *"Searched name, address, phone — NO customer record matches … Do NOT promise a cancellation or refund"*, plus a prompt to ask whether it was ordered under another name, email, or card |
| `matches: [...]` | each candidate with confidence + the signals that earned it, and *"NEVER act on a candidate without confirming identity"* |

Collapsing those two states is what produced the hallucination — the agent had not looked, and narrated a conclusion anyway.

## The paired prompt rules

`find_customer` alone doesn't fix the promise. [[sonnet-orchestrator]] carries a matching block — **UNIDENTIFIED CUSTOMER — IDENTIFY FIRST, PROMISE NOTHING**: acknowledge in one line, call `find_customer` with whatever was supplied, never escalate *"a human should search by name/address"* (that search is a tool), never name a remedy before eligibility is established, and **state only what the tools returned**.
