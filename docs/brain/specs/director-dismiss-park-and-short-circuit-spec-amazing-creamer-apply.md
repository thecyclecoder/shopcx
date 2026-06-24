# Apply dismiss-park + short-circuit to the Amazing Creamer park

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]]

## Phase 1 — apply both to the Amazing Creamer park

With the `dismiss-park` action and the `spec-status` `shortCircuit` flag live in prod, run the two actions on the live state:

- `dismiss-park` on the Amazing Creamer product-seed `agent_jobs` row with reason "underlying spec short-circuited — CEO 2026-06-24, see box-product-seeding."
- `spec-status` on [[box-product-seeding]]: `{status:'shipped', shortCircuit:true, reason:'no longer needed — CEO 2026-06-24, retained as reference: seed-product skill + this spec + brain pages stay grep-able for future product seeding.'}`

**Re-probe live state first.** Since the parent spec was authored, box-product-seeding's spec file has moved to `docs/brain/archive.d/box-product-seeding.md` and the archive index lists it as "Box-driven Product Seeding · verified 2026-06-22" — meaning the underlying `spec_card_state.status` is already `shipped` via the normal fold path. If that is still the case at apply time, the `spec-status` shortCircuit flip is moot (it can't move a shipped spec to shipped+short-circuited cleanly) and should be skipped, with a `director_activity` row logging the no-op + the live state observed. The Amazing Creamer parked `agent_jobs` row may also already be cleared by an earlier dismissal or auto-route — confirm it is still `needs_attention` before dismissing.

### Verification — Phase 1
- If the Amazing Creamer park is still `needs_attention` at apply time, after the dismiss it drops out of `routeNeedsAttention`'s candidate list and is no longer surfaced to the CEO.
- If [[box-product-seeding]]'s `spec_card_state` is not already shipped at apply time, after the short-circuit it renders shipped + short-circuited on the roadmap with the reason visible.
- The `seed-product` skill, [[box-product-seeding]] spec/archive page, and product-seeding brain pages stay intact and grep-able — short-circuit only flips status, it does not delete or unindex.
- If either action is moot (state has already moved on), a `director_activity` row records the no-op with the live state observed, and this card folds without further action.
