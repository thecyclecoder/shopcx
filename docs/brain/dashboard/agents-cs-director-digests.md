# Dashboard · agents / cs-director / digests

Phase 2 of [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]] — the founder's read + reply surface for the CS Director's weekly storyline digest.

**Route:** `/dashboard/agents/cs-director/digests`

## Features

**Page title:** CS Director digest

**Rendering:** `"use client"` component wrapped in a route-segment `<Suspense>` boundary (`layout.tsx`) per the cacheComponents rule. Fetches the latest digest on mount via GET, posts per-storyline reply actions via POST.

Renders the LATEST [[../tables/cs_director_digests]] row for the workspace:
- Header: the digest period + composed-at timestamp + a "Replied" badge when `ceo_replied_at` is set.
- One card per storyline (all three kinds: `early_warning`, `precedent_call`, `per_ticket_escalation`) — title, evidence, kind chip, proposed-action chip, and a per-storyline action row: **Widen leash · Tighten leash · Add policy · Add rule**.
- Buttons disabled once the digest has been replied (one action per digest — the digest is the reply unit).
- Empty state: "No digests yet" when the composer hasn't run for the workspace. "Quiet week" when `storylines=[]`.

## API endpoints called

- `GET /api/developer/agents/cs-director/digests/latest` — returns the newest `cs_director_digests` row for the caller's workspace. Owner-gated.
- `POST /api/developer/agents/cs-director/digests/[id]/reply` — applies one of the four actions. Body: `{ storyline_index: int, action: 'widen_leash' | 'tighten_leash' | 'add_policy' | 'add_rule' }`. Owner-gated. Uses [[../libraries/cs-director-digest-reply]] to mutate + stamp — the stamp is a COMPARE-AND-SET so a replay can't overwrite an already-actioned digest.

## Permissions

**Owner-only.** Both the GET and the POST reject a non-owner. Mirrors the leash-toggle surface (`POST /api/developer/agents/autonomy`) since three of the four actions land in owner-only tables (`function_autonomy`, `policies`, `sonnet_prompts`).

## Files touched

- `src/app/dashboard/agents/cs-director/digests/page.tsx` — the client page.
- `src/app/dashboard/agents/cs-director/digests/layout.tsx` — the Suspense boundary.
- `src/app/api/developer/agents/cs-director/digests/latest/route.ts` — GET.
- `src/app/api/developer/agents/cs-director/digests/[id]/reply/route.ts` — POST.
- `src/lib/cs-director-digest-reply.ts` — mutation helpers.

## Related

[[../tables/cs_director_digests]] · [[../libraries/cs-director-digest]] · [[../libraries/cs-director-digest-reply]] · [[../libraries/cs-director-black-swan]] · [[../inngest/cs-director-digest-composer]] · [[../specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply]] · [[agents]] · [[agents__directors]]

---

[[../README]] · [[../../CLAUDE]]
