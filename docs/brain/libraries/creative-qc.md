# `.claude/skills/creative-qc`

**Dahlia's per-render creative QC skill** — the vision pass she runs on every generated static before it lands in [[media-buyer-agent|Bianca]]'s ready-to-test bin, refactored (dahlia-creative-qc-via-box-session) from a direct Anthropic API call into a top-level `claude -p` on Max via this skill. The lane never needs an `ANTHROPIC_API_KEY` in prod — the Max subscription pays for the vision pass.

## Where it lives + how it's invoked

- **Skill file:** `.claude/skills/creative-qc/SKILL.md`
- **Invoked by:** [[builder-worker]] `runAdCreativeJob` — through the `qcDispatcher` closure it injects into [[creative-agent]] `runAdCreativeLoop`. Each per-creative QC becomes ONE `claude -p` session (kind `ad-creative-qc`, sandbox `max` → `ANTHROPIC_API_KEY` stripped, 6-min hard cap, 90s idle timeout, per-account failover via `runBoxLane`).
- **Consumer:** [[creative-qa]] `qaCreativeViaBoxSession` — writes the normalized 1568px JPEG to `/tmp/creative-qc-<uuid>.jpg`, builds the prompt, invokes the dispatcher, parses the returned JSON into the shared `CreativeQAVerdict` shape, and deletes the tmpfile.
- **Kill-switch:** `DAHLIA_QC_MODE` env — `box` (default) uses this skill; `direct` falls back to the legacy [[creative-qa]] `qaCreative` Opus API call unchanged. Any other value degrades to `box`.

## What the skill gets in the prompt

```
IMAGE: /tmp/creative-qc-<uuid>.jpg    ← ABSOLUTE PATH; the skill `Read`s it (Claude Code renders JPEGs visually)
HEADLINE: "…"                         ← the exact headline the ad should render (verbatim)
OFFER: "…" | none                     ← the exact offer overlay (verbatim), or the literal `none`
TRUST BAR: "…"                        ← the exact trust-bar overlay (verbatim)
HAS_TRANSFORMATION: yes | no          ← whether the ad carries a before/after transformation image
```

## What the skill returns — the `CreativeQAVerdict` JSON

The skill's final message is ONE JSON object (no prose, no fences) with the exact shape [[creative-qa]] `CreativeQAVerdict` already defines — no downstream consumer changes:

```json
{
  "pass": true,
  "issues": [],
  "checks": {
    "headlineExact": true,
    "textLegible": true,
    "noBarePrice": true,
    "noFabricatedPhotoCaption": true,
    "transformationPhotorealistic": true
  }
}
```

Contract:
- All five `checks` booleans are REQUIRED.
- `pass` = `true` **iff** every `checks` boolean is `true`. A mismatched top-level `pass` (checks all true but `pass:false`, or vice versa) is downgraded to `pass:false` by the consumer — trust the checks, not the summary.
- `issues[]` is one short human-readable string per failed check (empty on pass). The consumer synthesizes generic `failed: <name>` entries when `issues` is empty but `pass:false`.

## The five render checks

See [[creative-qa]] for the canonical table. Identical semantics to the legacy `qaCreative` path so the fail-closed regenerator loop ([[creative-agent]] `stockProduct`, `MAX_QA_ATTEMPTS`) behaves identically on either path.

## READ-ONLY / supervisable-autonomy invariant

The skill emits ONE JSON verdict — nothing else. It does NOT edit files, commit, call external APIs, or run scripts. The [[creative-agent]] Node loop is the ONLY component that mutates state — it regenerates on `pass:false` up to `MAX_QA_ATTEMPTS`, then inserts the passer into [[../tables/ad_campaigns]] (status='ready') with a static [[../tables/ad_videos]] child. Dahlia (this skill) optimizes a bounded proxy (render defects caught); Max holds her leash on the objective (in-market ROAS), matching the [[../operational-rules.md]] § North star.

## Fail-closed guarantee

Any error path in either the dispatcher or the skill resolves to `pass:false` so nothing unchecked reaches the bin. Concretely:

| failure | source | outcome |
|---|---|---|
| `ANTHROPIC_API_KEY` in child env | (impossible — sandbox `max` deletes it) | n/a |
| undecodable buffer | `sharp` in `qaCreativeViaBoxSession` | `pass:false` (`qa_image_undecodable`) |
| tmpfile write error | `writeFile` | `pass:false` (`qa_tmpfile_error: …`) |
| dispatch throws | worker closure | `pass:false` (`qa_session_dispatch_error: …`) |
| session `isError` (spawn / cap / timeout / all-Max-accounts-capped) | `runBoxLane` | `pass:false` (`qa_session_error`) |
| unparseable / non-JSON verdict | `extractLastJsonObject` | `pass:false` (`qa_session_unparseable`) |
| top-level `pass:true` with a false check | consumer downgrade | `pass:false` + `pass_true_with_failing_checks` in `issues` |

The regenerator burns an attempt on a fail — cheap compared to a Meta policy reject for a bare-price ad or a cartoon "before".

## Related
[[creative-qa]] · [[creative-agent]] · [[../lifecycles/ad-creative]] · [[builder-worker]] (`runAdCreativeJob`, `AD_CREATIVE_QC_TIMEOUT_MS`, `AD_CREATIVE_QC_IDLE_MS`) · [[../reference/meta-scaling-methodology]] (price-on-static + fabrication rules).
