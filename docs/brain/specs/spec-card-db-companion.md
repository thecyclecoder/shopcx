# Spec-card DB companion — instant PM state + deploy-pending flag ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends the roadmap/build-console; **supersedes + retires [[roadmap-reads-specs-from-git]]** (the live-GitHub approach that burned the API quota — this solves the same "instant status" goal from our own DB). Relates to [[spec-drift-agent]] (the reconciler keeps markdown ↔ DB in sync).

Today a card's status is parsed from the spec markdown's phase emojis (⏳🚧✅) **as bundled in the deployed build** — so a status change (a merge, a drift flip, an owner mark) doesn't show until a markdown edit + commit + **Vercel deploy**. That deploy lag is why the board feels stale, and why `roadmap-reads-specs-from-git` tried (wrongly) to read GitHub live. Move the *live* project-management state into a DB companion the board reads instantly.

## Model
- **`spec_card_state` table** (per workspace × spec_slug): `status`, `phase_states` (jsonb per phase), `flags` (e.g. `deploy_pending`, `building`, `blocked`), `last_merge_sha`, `updated_at`. The board reads this **DB-first** (instant), falling back to the markdown-parsed status when no row exists.
- **Canonical-source rule (the brain stays canonical):** the **markdown is canonical for spec *content* + the durable phase record**; `spec_card_state` is the **live mirror for the *board*** + transient flags that don't belong in committed markdown. On a true status conflict, **markdown wins** (it's what folds into the brain). The [[spec-drift-agent]] reconciler + the fold keep the two in sync — and become DB writes (instant) instead of markdown-edit-then-deploy.
- **Writers (instant):** a build merging → `status=shipped` for that phase + `deploy_pending=true` + `last_merge_sha`; a build starting → `building`; the drift reconciler / owner "mark verified" → flips; spec-blockers → `blocked`. All write the DB the moment the event happens.
- **`deploy_pending` (the "shipped · deploying" flag) — clean signal, no webhook:** the deployed app exposes its own `VERCEL_GIT_COMMIT_SHA`. If the live deployment's SHA is older than the card's `last_merge_sha`, the merged code isn't live yet → show **`shipped · deploying`**; once a deployment carrying that SHA is live → **`shipped · live`** (clear the flag). Generalizes the board's existing active-build "live overlay."

## Verification
- Merge a build for a spec → the card flips to **shipped instantly** (no deploy wait), tagged **`deploying`** until the deployment with that SHA goes live, then **`live`**.
- A drift flip / owner "mark verified" → reflects on the board immediately (DB write), not after the next deploy.
- A new deploy whose markdown disagrees with the DB → reconciled (markdown canonical), no permanent divergence; a spec with no `spec_card_state` row → falls back to markdown status (graceful).
- The board makes **zero GitHub API calls** for status (the regression `roadmap-reads-specs-from-git` caused) — all status is DB/markdown.
- Negative: a card mid-build shows `building` (not a false `shipped`); a card whose merge SHA is already live shows `shipped · live`, not a stuck `deploying`.

## Phase 1 — the table + instant writers + deploy-pending read ⏳
`spec_card_state` migration; write it from the merge-path / drift / build-lifecycle / owner-action paths; board reads DB-first with markdown fallback + the `deploy_pending` SHA comparison; render the `deploying`/`live` flag. Then delete the dead `roadmap-reads-specs-from-git` machinery. Brain: [[../libraries/brain-roadmap]] · [[../libraries/roadmap-actions]] · [[../tables/spec_card_state]] (new) · [[spec-drift-agent]] · [[roadmap-reads-specs-from-git]] (retire).
