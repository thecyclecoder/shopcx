# libraries/needs-attention-route

The **parked-job auto-router**. Every `agent_jobs` row that lands in `needs_attention` is swept here, classified, and dispatched to the lane that can actually resolve it — with a CEO escalation as the **fail-safe**, never the first move.

**File:** `src/lib/agents/needs-attention-route.ts` · **Tests:** `needs-attention-route.platform-owner-rung.test.ts`, `needs-attention-route-cs-owner.test.ts` · **Classifier:** [[needs-attention-classify]] · **Sibling:** [[needs-attention-route-cs-owner]]

Several brain pages link here as `[[needs-attention-route]]`; this is that page.

## ⭐ The routing principle — the owner rules on its own park

**A parked job is somebody's work before it is a founder's decision.** The org chart says a supervisor owns the layer below it ([[../operational-rules]] § North star), so a park routes to its **owner function** first, and reaches the CEO only when the owner genuinely cannot resolve it.

The failure mode this exists to prevent is measurable. On **2026-08-11** the CEO inbox held 27 open cards covering 14 real incidents, and **8 of those 14 were build-pipeline failures** — bug reports wearing an approval's clothes. One (`security-dep-watch`) had been parked **204 hours** with nobody fixing it, because *a card in the founder's inbox is not a work queue*. It is a place where work goes to be looked at, which is not the same thing.

There are two owner rungs, symmetric by design:

| Rung | Owns | Kinds | Lane it routes into |
|---|---|---|---|
| **CS-owner rung** | June (CS) | any kind whose registry owner is `cs` (`ticket-handle`, `ticket-analyze`) | enqueues a `cs-director-call` — [[needs-attention-route-cs-owner]] |
| **PLATFORM-owner rung** | Ada (Platform) | `BUILD_STYLE_KINDS` = `build` · `regression` · `repair` | appends a Fix phase + resumes the build — `routeAuthorBlocker` → [[pre-merge-fix]] |

Both sit **before** the backstop's CEO escalation, and both fall through to it when the lane declines.

## The sweep — `routeNeedsAttention(admin)`

Per row, in order (bounded by `PLATFORM_DIRECTOR_ROUTE_CAP`, ledger-deduped per job):

1. **Routed zombie** — class already starts with `routed_` → `clearRoutedZombie` flips it `completed`. Routing IS the disposition; leaving the row parked makes it re-report forever.
2. **Non-spec kinds** (`ticket-improve`) → dismissed outright, skipping the backstop entirely.
3. **CS-owner rung** → June. `loop_guard_tripped` already escalated, so the backstop is skipped (no double-page).
4. **`spec_row_missing`** → dismiss unless an open plan still owns the slug.
5. **Class dispatch** — `already_shipped` → fold · `real_blocker`/`tooling_failure` → `routeAuthorBlocker` · `design_change` → CEO chat invite.
6. **Backstop** (`routeBackstop`) — the subject of the next section.

## The backstop — and the Platform-owner rung inside it

`routeBackstop` has two branches:

**(a) Re-classify at `NEEDS_ATTENTION_STALE_MS` (60 min).** A row still `null`/`unknown` gets one fresh classification pass. If it *still* lands `unknown`:

- **PLATFORM-OWNER RUNG first.** For a `BUILD_STYLE_KINDS` row with a `spec_slug`, call `routeAuthorBlocker(admin, row, "unclassified")` — Ada's fix-phase lane takes its own work. On success the function **returns immediately** so branch (b)'s age alarm cannot also fire this pass, and `markRouted` stamps `routed_unclassified` so the next sweep clears the row terminal.
- **CEO fail-safe otherwise.** Mints the `Park needs eyes` card (`escalation_kind=park_backstop`), gated by both the job-scoped `activeParkCardExistsForJob` and the spec-scoped `openBuildStuckCardExistsForSpec` ([[approval-inbox]]).

**(b) Age alarm at `NEEDS_ATTENTION_ALARM_MS` (70 min)** — the "zero rows >70 min" invariant, and only when no other card already covers the job.

### Why the rung is bounded, and why it still always ends at a human

Routing work away from the founder is only correct if something else acts on it **and** the lane's own failure still pages. Every path terminates:

| Outcome | What happens |
|---|---|
| Lane declines (no spec row, fix phase couldn't spawn) | `routeAuthorBlocker` returns `false` → CEO fail-safe fires, exactly as before the rung existed |
| Lane spawns, the fix works | Build resumes; nothing to escalate |
| Lane spawns, fixes stop converging | [[pre-merge-fix]] loop-guard mints a CEO card (`premerge_fix_loop_guard`) |

Boundedness comes from `spawnPreMergeFix`: a per-origin loop-guard (`PRE_MERGE_FIX_LOOP_GUARD_MAX`) plus per-check-key dedup. The rung uses `check_key = blocker:unclassified`, so repeated undiagnosed parks on one spec **cannot stack fix phases**.

⚠️ **The loop-guard used to escalate to nobody.** Before 2026-08-11 it wrote an `escalated` [[../tables/director_activity]] row with **no `dedupe_key`** and minted no CEO card — and `reconcileSwallowedEscalations` ([[platform-director]]) filters the ledger to rows that *carry* a `dedupe_key`, so it was invisible on both surfaces. Harmless while nothing routed here on an undiagnosed park; **load-bearing the moment this rung shipped.** It now mints the card directly and stamps the key. Pinned by a regression test.

### What is deliberately NOT routed to Platform

A parked **`cs-director-call`** or **`security-review`** stays on the CEO fail-safe. Neither is a code bug this lane can fix, and routing one into a fix-phase lane would **bury a real decision** — the exact failure the rung is meant to prevent, inverted. `security-review` parks (e.g. "could not author dep-upgrade spec") remain an open gap with no owner rung.

### The `unclassified` disposition

`routeAuthorBlocker` takes a `BlockerRoute` = `real_blocker` | `tooling_failure` | **`unclassified`**. The third is the rung's honest "we could not classify it, but it is still ours" — deliberately a distinct value from `tooling_failure`, which asserts a diagnosis we do not have (and the box snapshot groups parks by this string). Its fix-session prompt names the uncertainty and instructs *diagnose first*, explicitly telling the session to leave it failing and say so rather than guess at a code change when the cause turns out to be a product decision, an outage, or a wrong spec — which routes it back to the founder.

Marker: `routed_unclassified`. `needs_attention_class` is plain `text` (no enum), and every `routed_*` marker participates in `clearRoutedZombie` via a prefix check, so no extra wiring is needed.

## Related

[[needs-attention-classify]] · [[needs-attention-route-cs-owner]] · [[pre-merge-fix]] · [[platform-director]] · [[approval-inbox]] · [[../tables/agent_jobs]] · [[../operational-rules]]
