# Surface Ada's repair-dismissals + a CEO Re-open override on the Control Tower

**Owner:** [[../functions/platform]] · **Parent:** [[platform-director-agent]] — extends the director's supervision of [[repair-agent]] under [[../goals/devops-director]]

## Phase 1 — surface the dismissal + a CEO re-open override
- On the [[../dashboard/control-tower]] tile, render a dismissed item as `🛠️ Dismissed by Ada — <reasoning>` (instead of it silently vanishing) with a one-tap **Re-open** that restores the warning and re-enqueues Rafa. This is the CEO's supervision over Ada — full visibility into what she cleared and an instant undo.
- A daily rollup line in the [[../libraries/platform-director]] board watch (`postPlatformWatchUpdate` / `composePlatformWatchBody`): 'reviewed N of Rafa's calls — dismissed K, escalated J back to you.'

### Verification — Phase 1
- A Director-dismissed item shows `Dismissed by Ada` + reasoning on the Control Tower; tapping Re-open restores the open warning and a fresh `repair` job. The board-watch post counts the day's dismissals + escalations.
