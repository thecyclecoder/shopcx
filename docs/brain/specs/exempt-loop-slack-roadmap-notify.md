# Exempt loop from coverage monitoring: slack-roadmap-notify ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends the [[control-tower-complete-coverage]] coverage self-audit · auto-proposed by [[../libraries/coverage-register-agent]].

The owner marked `slack-roadmap-notify` **intentionally-unmonitored** — a registered exemption so the coverage self-audit stops flagging it (silence is never the default; this is the owner-confirmed exception).

## Phase 1 — add the INTENTIONALLY_UNMONITORED_CRONS exemption ⏳
In `src/lib/control-tower/registry.ts`, add to `INTENTIONALLY_UNMONITORED_CRONS`:

```ts
  "slack-roadmap-notify": "intentionally unmonitored — owner-confirmed via the coverage-register agent",
```

No other change. After merge + deploy the audit no longer flags `slack-roadmap-notify` as an unregistered loop.

## Verification
- On /dashboard/developer/control-tower, the Coverage self-audit no longer lists "Unregistered loop: slack-roadmap-notify".

<!-- coverage-register exemption: exempt-loop-slack-roadmap-notify for loop slack-roadmap-notify -->
