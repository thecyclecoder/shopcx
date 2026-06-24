# Active-directive card on the Agents hub ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — extends the coaching seat ([[director-proposed-goals]] pattern) + the standing pass under [[../goals/devops-director]]
**Deferred:** split from [[director-executable-plans-and-priority]] — not needed now: the active directive is already surfaced three ways — the standing-pass note + the daily board-watch note ("🎯 active directive: X · builds GATED until Y ships", builder-worker.ts:1752) and the coach chat. A dedicated hub card is redundant visibility polish, not required for the directive system to work or for Ada to explain it.

## Phase 1 — a dedicated directive card on the Agents hub / her profile ⏳
- Render a dedicated card for the one `active` [[../tables/director_directives]] row on the [[../dashboard/agents|Agents hub]] / the platform director's profile: the directive summary, its steps, the `gate_builds_until` spec (with a "builds GATED until Y ships" badge), and a clear/complete affordance. Mirrors how the directive already headlines the standing pass.
- Surfacing already exists via the standing-pass note + the daily board-watch note + the chat; this is the dedicated, always-visible hub surface.

### Verification
- With an `active` directive present, `/dashboard/agents` (or the platform profile) shows a directive card naming the directive + its gate; with no active directive the card is absent. `npx tsc --noEmit` clean.