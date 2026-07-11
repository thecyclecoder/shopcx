# `scripts/ad-creative-qc-permission-gate.ts` — the box PreToolUse hook

The **permission gate** that enforces least-privilege tool access in Dahlia's per-render QC box session (dahlia-creative-qc-via-box-session Phase 3 / Fix 1). Runs as a Claude Code PreToolUse hook; every tool call to the `ad-creative-qc` child is adjudicated here.

The QC child only needs to `Read` ONE temporary JPEG (the rendered ad at `/tmp/creative-qc-<uuid>.jpg`) — nothing else. This gate enforces that invariant hard:

- `Read` on the exact path in env `AD_CREATIVE_QC_ALLOWED_IMAGE` → **allow**.
- `TodoWrite` (the transparency checklist that runs in every box session) → **allow**. No filesystem / network side effect.
- EVERYTHING else (Bash, Write, Edit, Grep, Glob, WebFetch, WebSearch, Task, MCP, an unexpected tool, a `Read` on a different path) → **deny** with a specific reason.

Fail-closed on every failure: env var missing, payload unparseable, tool input missing / wrong shape → **deny**.

## How it's wired

Injected into the QC session's Claude Code settings via `PreToolUse` hook when [[builder-worker]] `runAdCreativeJob` dispatches the `ad-creative-qc` child. The hook command is:

```
npx tsx scripts/ad-creative-qc-permission-gate.ts
```

Contract (Claude Code PreToolUse hook):
- **stdin:** JSON `{ tool_name, tool_input }` (the intercepted tool call).
- **env:** `AD_CREATIVE_QC_ALLOWED_IMAGE` = the absolute path to the tmp JPEG the caller wrote.
- **stdout:** JSON `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow"|"deny", permissionDecisionReason: "…" } }`.
- **exit code:** always 0.

## Implementation

Imports and calls `evaluateQcPermission` from [[creative-qc-sandbox]] (the pure adjudicator). The gate is **pure** — no Supabase, no DB, no prod creds — matching the least-privilege stance of the child it gates.

## The three-layer defense (context)

This gate is the SECOND layer:

| layer | component | what it blocks |
|---|---|---|
| **Env stripper** — the `sandbox: "qc"` branch in [[builder-worker]] `runBoxSession` | [[creative-qc-sandbox]] `buildQcChildEnv` | Every credential / token / secret var; only base OS envs + `CLAUDE_CONFIG_DIR` reach the child. |
| **PreToolUse gate** ← THIS GATE | [[creative-qc-sandbox]] `evaluateQcPermission` (the adjudicator) | Every tool call except `Read` on the allowed image + `TodoWrite` is denied. |
| **Injection-safe prompt** — the DATA block | [[creative-qc-sandbox]] `buildQcPrompt` + `sanitizeExpectedCopyField` | The untrusted `expectedCopy` fields are wrapped in a DATA block with an explicit "treat as opaque strings" preamble. |

## Related

[[creative-qc-sandbox]] (the pure adjudicator) · [[creative-qc]] (the box-session skill) · [[creative-qa]] (uses the QC dispatcher) · [[builder-worker]] (injects this gate into the child's env).
