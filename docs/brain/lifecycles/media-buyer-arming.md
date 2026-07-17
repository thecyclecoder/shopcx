# Lifecycle: Media Buyer arming (shadow ↔ armed)

The owner-vetoable flip that moves a workspace's Media Buyer cohort from `iteration_policies.mode='shadow'` (audit-only) to `mode='armed'` (executor may act) — and the symmetric disarm the owner uses to yank it back. Encodes the [[../functions/growth]] media-buyer-supervision goal's M3 "autonomous ad-spend stays human-vetoable" requirement (folded 2026-07-09; see § Status / open work) as a real API + audit surface, not a raw SQL invitation.

Phases 1 + 2 of [[../specs/media-buyer-armed-flip-surface]]; blocked-by the deterministic arming-gate ([[../specs/media-buyer-arming-gate]]) that authors the [[../tables/media_buyer_arming_authorization]] rows this route reads.

**Code:**
- Phase 1 API: `src/app/api/growth/media-buyer/arm/route.ts` (POST) · [[../libraries/approval-router]] `resolveApproverLive('growth')` · [[../tables/iteration_policies]] `mode` column · [[../tables/media_buyer_arming_authorization]] · [[../tables/director_activity]] via [[../libraries/director-activity]] `recordDirectorActivity`.
- Phase 2 tile: `src/app/dashboard/growth/media-buyer/page.tsx` (client `MediaBuyerCohortsPage`) · `src/app/dashboard/growth/media-buyer/layout.tsx` (Suspense boundary for cacheComponents) · read via `src/app/api/growth/media-buyer/cohorts/route.ts` (GET). Owner-role member sees Arm / Disarm buttons; Arm is enabled ONLY when the newest authorization is `allowed=true` AND `expires_at > now()`. Non-owner members see the same tile read-only (buttons hidden).

## The three transitions

| From → To | Trigger | Gate | Writes |
|---|---|---|---|
| `shadow` → `armed` | Owner POST `{direction:'arm'}` | Fresh authorization row (allowed=true, expires_at > now) AND `resolveApproverLive('growth') === 'growth'` (live+autonomous). Otherwise the request drops into a `needs_approval` agent_jobs row routed UP the org chart. | `iteration_policies.mode='armed'` + one `director_activity` `media_buyer_armed`. |
| `armed` → `shadow` (owner disarm) | Owner POST `{direction:'disarm'}` | None — always allowed. | `iteration_policies.mode='shadow'` + one `director_activity` `media_buyer_disarmed` (`metadata.reason` = user-supplied or `'manual'`). |
| `armed` → `shadow` (self-disarm) | Arming-gate re-evaluation flips `allowed=false` on the ISO week's authorization row → the gate's next arm request is refused; the executor treats an expired/denied row as a rail and the Media Buyer stays in shadow. See [[../libraries/media-buyer-agent]] + [[../libraries/media-buyer-publish-gate]] for the rail semantics. | The gate itself (not this route). | `media_buyer_arming_denied` (see [[../specs/media-buyer-arming-gate]]). |

## Arm flow (POST `/api/growth/media-buyer/arm` with `direction:'arm'`)

1. **RBAC** — the user must be a `workspace_members` row for `workspace_id`; else `403 Forbidden`. Owner-only enforcement lives in the Phase 2 dashboard (button visibility); the API accepts any member so the future automation surfaces can call it too.
2. **Load the latest authorization** — newest `media_buyer_arming_authorization` for `(workspace_id, meta_ad_account_id | null)` ordered by `evaluated_at desc`. Missing / `allowed=false` / `expires_at < now()` → `409 { error: 'authorization_stale', detail, expires_at }`. NO mutation, NO audit — the owner sees exactly why the flip refused.
3. **Route the approval** — `resolveApproverLive('growth')` walks UP the org chart to the first live+autonomous ancestor (else the CEO fallback root).
    - **`routedTo === 'growth'`** — the Growth Director is trusted to auto-decide its own arm request → fall through to the mutation step.
    - **`routedTo !== 'growth'`** (typically `'ceo'` because Growth isn't live+autonomous) — INSERT one `agent_jobs` row with `kind='growth-director'`, `status='needs_approval'`, `spec_slug='media-buyer-armed-flip-surface'`, and one `pending_actions[0] = { type:'apply_media_buyer_arm', payload:{ workspace_id, meta_ad_account_id, authorization_id, blended_cac_ltv_snapshot, raised_by_actor } }`. Return `202 { needs_approval: true, routed_to, job_id }`. On approve the worker re-runs the arm branch against the pinned authorization.
4. **Mutate** — `UPDATE iteration_policies SET mode='armed' WHERE workspace_id AND status='active' AND campaign_id IS NULL RETURNING id`. The v1 scope is workspace-wide (`campaign_id IS NULL`), matching how [[../libraries/iteration-policy-authoring]] authors + activates rows.
5. **Audit** — one `director_activity` `media_buyer_armed` under `director_function='growth'` with `metadata = { authorization_id, blended_cac_ltv_snapshot, actor, updated_policy_ids, routed_to, autonomous }`. The `blended_cac_ltv_snapshot` is the `metrics` object the arming-gate stored on the authorization row (see [[../libraries/media-buyer-arming-gate]] `upsertAuthorization`), so the ledger carries the exact CAC:LTV picture that greenlit the flip.
6. **Response** — `200 { ok:true, mode:'armed', authorization_id, updated_policy_ids }`.

## Disarm flow (POST with `direction:'disarm'`)

Skips the authorization check + the approval router — a disarm is a safety valve the owner always holds.

1. **RBAC** — same workspace-member gate.
2. **Mutate** — `UPDATE iteration_policies SET mode='shadow' WHERE workspace_id AND status='active' AND campaign_id IS NULL RETURNING id`.
3. **Audit** — one `director_activity` `media_buyer_disarmed` under `director_function='growth'` with `metadata = { reason: body.reason ?? 'manual', meta_ad_account_id, actor, updated_policy_ids, autonomous:false }`. The `reason` string is echoed onto both the top-level `reason` column and `metadata.reason` so the recap / EOD read either shape.
4. **Response** — `200 { ok:true, mode:'shadow', updated_policy_ids }`.

## Self-disarm (arming-gate refuses re-evaluation)

The route above is the **owner-driven** transition. The **autonomous** side of the cycle lives in [[../libraries/media-buyer-arming-gate]]: on each weekly re-evaluation, if any of the three predicates (shadow-review agreement / sensor-trust green streak / blended CAC:LTV target) fails, `runMediaBuyerArmingGate` writes `allowed=false` on the authorization row + escalates to the CEO via [[../libraries/platform-director]] `escalateDiagnosisToCeo` + records `director_activity` `media_buyer_arming_denied`. The executor treats an `!allowed` (or `expires_at < now()`) authorization as a rail and stays in shadow — no owner action required. The next owner arm attempt against a denied row 409s with `authorization_stale`, so the ledger's "flip refused" trail is unambiguous.

## Invariants

- **Service-role writes only** — the route uses `createAdminClient()` (past RLS) with the workspace-member gate above; no client can write `iteration_policies.mode` directly.
- **v1 scope: workspace-wide** — the UPDATE fixes `campaign_id IS NULL`, mirroring the [[../libraries/iteration-policy-authoring]] pattern. A per-campaign override is reserved on the schema for later — until then, one active policy per workspace carries the mode.
- **Compare-and-set audit** — the UPDATE uses `.select('id')` to return the ids that transitioned. The audit row carries `metadata.updated_policy_ids` so a zero-length list (no active policy for the workspace) is legibly recorded as "no-op flip" rather than silently succeeding.
- **Disarm is unconditional** — no authorization check, no approval routing. The safety valve is the owner's; a routing rail could otherwise trap the workspace in armed on a director-agent outage.

## Status / open work

**Shipped — goal `autonomous-media-buyer-supervision` folded complete 2026-07-09.** The arming flip on this page is M3 of a four-milestone goal (owned by [[../functions/growth]]) that took the already-built Media Buyer loop ([[../functions/growth]] § Static-ad optimization → `media-buyer-test-winner-loop`) from dormant code to a **live, supervised, self-correcting** system over the Amazing Coffee + Superfood Tabs test cohorts. The CEO guardrail — *shadow/read-only before armed, autonomous ad-spend stays human-vetoable* — is encoded end-to-end across these permanent homes:

- **M1 — Sensor trust.** Per-cohort iteration-policy calibration ([[../libraries/media-buyer-policy-calibrator]]) + the sensor-trust probe ([[../libraries/media-buyer__sensor-trust-probe]] → [[../tables/media_buyer_sensor_trust]]) prove the loop's per-creative ROAS read is trustable before any budget moves.
- **M2 — Shadow mode (read-only).** The daily cadence cron ([[../inngest/media-buyer-cadence]]) runs the loop over both cohorts in `mode='shadow'`, logging what it *would* do to [[../tables/media_buyer_shadow_reviews]] and delivering the Growth Director (Max) digest — recommend, never spend.
- **M3 — Armed (bounded autonomous execution).** *This lifecycle* — the deterministic weekly arming gate ([[../libraries/media-buyer-arming-gate]] → [[../tables/media_buyer_arming_authorization]]) plus the owner-vetoable flip surface (route + dashboard tile) that moves a cohort `shadow → armed` only on a fresh authorization, and yanks it back on demand.
- **M4 — Graded + self-correcting.** The daily grader cron ([[../inngest/media-buyer-grade]] → [[../libraries/media-buyer-grader]] → [[../tables/media_buyer_action_grades]]) scores each executed action against realized ROAS resolved 3d+ later; the grade rollup ([[../libraries/media-buyer-grade-rollup]]) surfaces it on the Growth Director's brief; and the auto-revert ([[../inngest/media-buyer-self-correcting]] → [[../libraries/media-buyer-self-correcting]]) flips a slipping cohort back to `shadow` + escalates the CEO — the ⭐ north-star discipline (proxy-optimizing tool → objective-owning director → CEO) made mechanical.

**Outcome:** the Media Buyer runs daily on both cohorts, its shadow calls matched human review within tolerance, and once armed it holds blended CAC at/under the LTV-derived target with no required daily human intervention — self-disarming on regression. The shared `shadow ↔ armed` mutation both this route and the self-correcting revert call is [[../libraries/media-buyer__mode-flip]].

**Open work:** per-campaign `iteration_policies.mode` overrides (v1 is workspace-wide, `campaign_id IS NULL`); extending the cohort set beyond the two launch products.

### Follow-on goal — `bianca-temperature-aware-campaign-structure` (folded complete 2026-07-17)

Where the supervision goal above made the **test cohort** live, supervised, and self-correcting, this goal gave Bianca the thin **temperature-aware account STRUCTURE** the loop was missing — three surfaces routed by Dahlia's `audience_temperature` tag, plus a SECOND arming gate for the highest-risk surface. Owned by [[../functions/growth]]; the CEO north star it serves — *a scaler Max can't grade is the one thing this must not create* — is encoded as a campaign-level CAC:LTV sensor + a per-surface arming gate, never raw autonomous spend. The research verdict that shaped it: Meta pools + self-sorts cold traffic by the ad's own creative signal ("creative IS the targeting"), so heavy audience segmentation is dropped — the three surviving obligations Meta will NOT do are temperature routing (our construct), new-vs-existing-buyer separation, and signal hygiene.

**The three surfaces (the durable architecture):**
- **Surface 1 — TEST** (the existing lab, hardened): per-product ABO, 4×$150 single-creative adsets judged on cost-per-ATC, perpetual feeder. M1 aligned the default targeting to the proven **US women 50-65** converter (was US 18-65, no gender — which confounded the per-creative CPA read the crown/kill call depends on) and honored the [[../tables/iteration_policies]] scale-edit rails (`per_object_cooldown_hours` + `per_account_daily_budget_delta_ceiling_cents`) the executor had been ignoring. M2 added a **recent-purchaser exclusion** on every cold-test adset (backed by a full-order-history hashed customer-list exclusion audience, refreshed) after a one-shot measurement confirmed the existing-buyer overlap cleared the ~15% ship threshold. Corrected harm model: contamination → **false crowns** (weak creative promoted to concentrated budget), not false kills — so the exclusion + the scaler are coupled.
- **Surface 2 — COLD-SCALE** (the real gap, M4): ONE consolidated Advantage+/CBO with native "Acquire New Customers Only", optimizing for purchase VALUE, where crowned winners graduate off the $600 lab ceiling. Ships **bounded + supervised** with three of its own rails: a cohort + daily ceiling ([[../tables/media_buyer_cold_scaler_cohorts]] via [[../libraries/cold-scaler-cohort]]), a **shadow→armed weekly arming gate** ([[../libraries/media-buyer__cold-scaler-arming-gate]] → [[../tables/media_buyer_cold_scaler_arming_authorization]] — distinct from the test-cohort gate on this page), and a campaign-level **CAC:LTV sensor** ([[../libraries/media-buyer__cold-scaler-cac-ltv-sensor]] → [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]]) that keeps the scaler gradable by Max where per-creative ROAS can't reach.
- **Surface 3 — HOT-RETARGET**: DEFERRED out of this goal — one account-level DPA/offer lane, only after Dahlia's Hot lane exists AND an incrementality measurement vs Advantage+'s built-in retargeting. Skipped entirely: lookalikes, interest tiers, warm/cold adset matrices, hashed-list exclusion chains.

**Temperature routing (M3):** Bianca's ready-creative picker is TEMPERATURE-scoped to `'cold'` ([[../libraries/media-buyer-agent]]) so a Warm/Hot creative Dahlia tagged (via the Dahlia copy-engine goal's `audience_temperature` column) can't leak into the cold rail's deficit fill; Hot/Warm creatives are parked until Surface 3 exists.

**Sequencing:** M1 + M2 were Bianca-side and independent of Dahlia (paid off during the creative freeze); M3 gated on Dahlia's temperature column; M4 gated on Dahlia supplying a steady crowned-winner stream (can't seed a scaler with a paused creative engine). All four milestones landed.

**Open work:** Surface 3 (hot-retarget) remains deferred; the cold scaler ships shadow-first and arms only under its weekly gate.

## Related

- [[../specs/media-buyer-armed-flip-surface]] (this spec) · [[../specs/media-buyer-arming-gate]] · [[../specs/media-buyer-shadow-mode]]
- [[../tables/iteration_policies]] · [[../tables/media_buyer_arming_authorization]] · [[../tables/media_buyer_action_grades]] · [[../tables/director_activity]]
- Cold scaler (follow-on goal): [[../tables/media_buyer_cold_scaler_cohorts]] · [[../tables/media_buyer_cold_scaler_arming_authorization]] · [[../tables/media_buyer_cold_scaler_cac_ltv_snapshots]] · [[../libraries/cold-scaler-cohort]] · [[../libraries/media-buyer__cold-scaler-arming-gate]] · [[../libraries/media-buyer__cold-scaler-cac-ltv-sensor]]
- [[../libraries/approval-router]] · [[../libraries/director-activity]] · [[../libraries/media-buyer-arming-gate]] · [[../libraries/media-buyer-agent]] · [[../libraries/media-buyer-self-correcting]] · [[../libraries/media-buyer__mode-flip]]
- [[../functions/growth]] (owning function) · [[../inngest/media-buyer-cadence]] · [[../inngest/media-buyer-grade]] · [[../inngest/media-buyer-self-correcting]]
