# Brain accuracy: Platform is live+autonomous — correct stale 'dormant/not-live' claims ✅

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — the brain must reflect the director's actual live state, under [[../goals/devops-director]]
**Found in use 2026-06-24:** the director's own groom note asserted 'Platform is not yet live+autonomous' and partly deferred a reconcile on that premise — but `function_autonomy` has `platform` `live=true, autonomous=true` since **2026-06-23 20:35** (set by `ceo`). The stale fact came from brain prose that still narrates Platform as not-yet-activated. A stale brain fact fed a wrong autonomous decision — so this is load-bearing accuracy, not cosmetics.

## Phase 1 — correct the stale current-status claims (keep the conditional-behavior docs) ✅
- Treat [[../tables/function_autonomy]] as the source of truth: `platform` = live + autonomous since 2026-06-23 20:35 (`updated_by=ceo`). [[../goals/devops-director]] M4 (first live director) is ACHIEVED.
- Fix [[../goals/devops-director]]: 'Today no director is automated → everything lands in the CEO inbox' → the **Platform/DevOps Director (Ada) is live+autonomous since 2026-06-23**; platform-owned approvals now route to Ada (auto-approved within the leash, logged), not the CEO inbox. Shift the 'as each director comes online' narrative to past-tense for Platform.
- Fix [[../libraries/platform-director]]: the 'Dormant until activation … built but inert' line + the per-export 'dormant until live+autonomous' asides — note ACTIVATION HAPPENED, so the runtime guards currently PASS and the surfaces are LIVE. KEEP the accurate conditional-behavior wording ('no-op unless live+autonomous') — we're correcting current-status prose, not the code-behavior docs.
- Check [[platform-director-agent]] + [[../functions/platform]] for any remaining 'not yet live / activation pending' phrasing and align (functions/platform.md already says 'first function to go fully autonomous' — keep).
- Brain: [[../goals/devops-director]] · [[../libraries/platform-director]] · [[platform-director-agent]] · [[../tables/function_autonomy]].

### Verification — Phase 1
- No brain page states as current-fact that Platform / the director is not-yet-live or 'inert'; the dated activation (2026-06-23 20:35, by ceo) is reflected; the conditional code-behavior descriptions are preserved (still say the surfaces no-op when the flag is off).

## Phase 2 — the director reads function_autonomy for its own live-state (recurrence guard) ✅
- ✅ Every read-only `claude -p` investigation (approval / groom / init / repair-dismissal) is now wrapped through one box-lane seam (`scripts/builder-worker.ts` `directorDecisionPrompt`) that prepends `directorLiveStateFact` ([[../libraries/platform-director]]) — the AUTHORITATIVE live-state read straight from [[../tables/function_autonomy]] (`live`/`autonomous` + dated `updated_at`/`updated_by`), the SAME DB row the lanes' runtime guards gate on — and then the CEO coaching (P7). The brief tells her explicitly to decide on the DB flag and that it WINS over any stale brain prose ('dormant'/'not yet live'/'inert'). Best-effort + fail-safe (a missing row / read error renders 'UNKNOWN — treat as NOT live'). So a groom/escort/approval decision can never again be premised on a stale 'not live' reading.
- The optional 'Activation status' line on the director's [[../dashboard/agents|profile]] page was NOT added — it is explicitly optional and out of this build's scope; the DB-keyed home for the fact is `directorLiveStateFact` (injected into every decision prompt), which already removes the drift the phase targets.

### Verification — Phase 2
- A groom/escort investigation brief carries the function_autonomy live-state; a decision's reasoning reflects the actual flag, never stale prose. (Regression check: the director never again defers/escalates citing 'not live+autonomous' while the flag is on.)

## Related action (not in this spec)
The deferred [[director-escalations-must-surface-to-ceo-backfill-swallowed]] reconcile was split off partly on the now-corrected 'can't fire today' premise. With Platform live, it is applicable now and would surface the stranded [[agent-outage-resilience]] P3 escalation — recommend promoting it from Deferred back to Planned to build.