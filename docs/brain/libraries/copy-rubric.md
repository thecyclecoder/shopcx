# `src/lib/ads/copy-rubric.ts`

The **shared 0-10 Conversion-Psychology rubric** — the single source of truth both Dahlia (the M1 copy author session) and Max (the M1 independent copy QC session) will import so their scoring cannot drift. The M1 keystone of [[../goals/dahlia-imitate-then-innovate-copy-engine]]: without a shared rubric, Max's QC would degenerate into a rubric mirror of Dahlia's self-score (defeating the independent-QC bounce-rate proof) and author-mode CAC/CTR would not be decomposable into which sub-score moved.

Mirrors the [[lf8]] SSOT pattern that already prevents the ads-supervisor gate from diverging from `buildMetaCopy` — a single edit to any sub-rubric here mutates both downstream call sites in one commit.

## The rubric

Five 0-2 sub-scores that sum to a 0-10 total:

| Sub-score | 0..2 | Reference framework |
|---|---|---|
| **LF8** | Life-Force-8 keyword density | Dr. Edward Whitman's 8 core desires (via [[lf8]]) |
| **Schwartz** | 5 stages of awareness | Eugene Schwartz (Breakthrough Advertising) |
| **Cialdini** | 7 principles of influence | Robert Cialdini (Influence) |
| **Hopkins** | Specificity | Claude Hopkins (Scientific Advertising) |
| **Sugarman** | Slippery-slide | Joe Sugarman (The Adweek Copywriting Handbook) |

Total = sum of the five, clamped to `0..10`.

### Deterministic scoring (documented pattern scans)

The scorer is **pure** and **deterministic** — same inputs, same bytes out. The point is a rubric BOTH agents can render and reason over, not a state-of-the-art scorer.

- **LF8** — imports `LF8_KEYWORDS` from [[lf8]] (SSOT — no duplicate list). 2 iff ≥2 distinct keywords hit `headline+primaryText` (lowercased), 1 iff exactly one, 0 iff none.
- **Schwartz** — level-detector over five word-buckets (unaware < problem-aware < solution-aware < product-aware < most-aware). 2 iff product-aware (copy names the brief's `productTitle`) or most-aware (offer/CTA words), 1 iff problem-aware or solution-aware, 0 iff unaware.
- **Cialdini** — counts how many of the seven principle-buckets (reciprocity, commitment, social-proof, authority, liking, scarcity, unity) have at least one hit. 2 iff ≥3 buckets, 1 iff 1–2, 0 iff none.
- **Hopkins** — counts specificity markers: digit runs + unit tokens (mg, g, oz, day, week, month, year, hour, minute, serving, ingredient). 2 iff ≥3 markers, 1 iff 1–2, 0 iff none.
- **Sugarman** — 2 iff copy has a curiosity hook (`?`, `what if`, `why`, `how`, `the truth`, `here's`, `imagine`, `picture this`) AND primary text has ≥2 sentences; 1 iff either; 0 iff neither.

Every sub-score contributes **≥1 evidence line** to `score.evidence[]`, so the caller can render "why we scored 7" for the human reviewer.

### Phase 3 — LEAD-BENEFIT signal (soft penalty, [[../specs/dahlia-hooks-riff-competitor-angle-and-weave-in-lead-benefit]], 2026-07-18)

`scoreConversionPsychology` also emits a `leadBenefitPenalty: 0 | -1` field on the score, applied as a total-level adjustment BEFORE the `0..10` clamp. The rail is **advisory-soft** — never a hard gate:

- `0` — no penalty. Fires when the brief has NO `leadBenefitWeave` (own-brand angle OR the [[creative-brief]] Phase 2 minority pure-competitor explore slot) OR when the headline touches a lead-benefit token (the `benefitName`, one of the `softPhrasings`, or a distinctive ≥5-char word from the benefit name).
- `−1` — one-point deduction. Fires ONLY when the brief carries a `leadBenefitWeave` (a competitor RIFF is required, per Phase 2) AND the headline touches none of those tokens — the exact "pure borrow of a competitor commodity truth with the differentiator absent" state Amazing Coffee's 2026-07-18 cold creative surfaced (`"Tired of the coffee jitters?"` with our weight-loss differentiator nowhere in the hook).

The rail is **soft by design** so a deliberately-explore competitor angle scoring well on the other five sub-scores can still clear the floor and ship; the minority explore slot's brief has `leadBenefitWeave=null` and cannot receive the penalty at all — the rail preserves the explore. CEO north-star example: `"Tasty coffee, feel lighter, no jitters"` → `0` (RIFF present via `feel lighter`); `"Tired of the coffee jitters?"` → `−1` (pure borrow). Pinned by `src/lib/ads/copy-rubric.test.ts` (Phase 3 blocks).

### M2 layer — deep DR vocabulary in the sub-descriptors

The five sub-descriptor consts (`LF8_SUBSCORE_RUBRIC`, `SCHWARTZ_LEVELS_1_TO_5`, `CIALDINI_PRINCIPLES`, `HOPKINS_SPECIFICITY_RULES`, `SUGARMAN_SLIPPERY_SLIDE`) are the M2 **Five Frameworks in-context copy skill** layer over the M1 scorer SSOT (spec: [[../specs/dahlia-five-frameworks-copy-skill]]). Each descriptor carries the actual DR playbook prose Dahlia's author box session writes against — **not** just framework names. `renderRubricForPrompt()` embeds the descriptors verbatim, so a single edit here mutates both the Dahlia author-mode prompt AND the Max QC prompt in one commit.

The deep vocabulary the descriptors carry:

- **Schwartz** — the five awareness levels (`L1` UNAWARE → `L5` MOST-AWARE) with **two concrete example lines per level** (e.g. L4 product-aware: *"adaptogens + L-theanine, no crash"*; L5 most-aware: *"vs coffee alone: 47 fewer crash calories, +2h focus"*), so Dahlia writes AT the market's sophistication level rather than a level below.
- **Cialdini** — all seven principles (RECIPROCITY, COMMITMENT, SOCIAL PROOF, AUTHORITY, LIKING, SCARCITY, UNITY) with a **one-line worked example per principle** whose shape Dahlia can steal.
- **Hopkins** — three concrete-numbers-over-generalities authoring rules: (1) replace *"many"* with an exact count; (2) replace *"quickly"* with a real timeframe in days or minutes; (3) replace *"people"* with a real named reviewer.
- **Sugarman** — four line-earns-the-next micro-rules: (1) first sentence ≤ 1-second reading time; (2) each line ends on a **curiosity gap**, not a period the reader can rest on; (3) no benefit line follows another benefit line — alternate benefit / proof / benefit / proof; (4) the last line invites the click, does not summarize.

The unit tests pin the presence of `L1..L5`, the seven Cialdini names, the three Hopkins rules, and the four Sugarman micro-rules in `renderRubricForPrompt()`'s output while still enforcing byte-stability across repeated calls — the SSOT invariant [[../specs/dahlia-conversion-psychology-rubric-module]] shipped.

### Phase 2 — scroll-stop + ellipsis-aware + benefits-not-product opener guidance ([[../specs/dahlia-primary-text-scroll-stopping-benefit-led-not-product-led]], 2026-07-18)

The **SUGARMAN** and **LF8** sub-descriptors carry sharpened Cashvertising guidance so the 0-10 self-score honestly rewards a front-loaded curiosity+benefit opener and docks a product-led or flat-summary opener. Both rails are **advisory-soft** — never hard gates — so the deterministic scorers stay unchanged; the descriptor text is what pushes Dahlia's self-score and Max's independent QC toward the same authoring intent.

- **SUGARMAN (scroll-stop + ellipsis-aware opener).** Meta truncates primary text after roughly the first 1-2 lines with a `…more` ellipsis, so the opening 1-2 lines carry the entire scroll-stop burden. The descriptor rewards a curiosity / unexpected / contrarian pattern-interrupt opener that leads with the reader's benefit (an open loop, a reversal, a contrarian claim, a pattern-interrupt story) and docks a product-led opener (`"<Product> is…"` / `"Meet <Brand>…"`), a flat one-line benefit-summary that gives the whole promise away before the ellipsis, and a feature/ingredient list opener. The `2 / 1 / 0` bands are updated so a hook the reader has no reason to expand past cannot score `2` regardless of how many sentences follow.
- **LF8 (benefits-not-product Cashvertising).** LF8 counts keywords because those keywords ARE the reader's benefit vocabulary. The descriptor calls out that leading with the reader's OUTCOME (the transformation, the feeling, the pain removed) makes the LF8 keyword-count land honestly, while a product-led opener that names the product/brand before any benefit typically buries the count. Strongest for COLD audiences (Schwartz 1-2). The deterministic scorer stays the same simple hit-counter — the guidance is what makes the count reflect authoring intent.

Both descriptors state `advisory-soft — never a hard gate` in their own text; the total remains a 0-10 self-score. Mirrored in the [[../../.claude/skills/dahlia-copy-author/SKILL.md]] `self_score` section so Dahlia self-scores against the same axis intent Max's QC will score against. Pinned in `src/lib/ads/copy-rubric.test.ts` (Phase 2 tokens: `scroll-stop`, `ellipsis`, `pattern-interrupt`, `contrarian`, `product-led`, `benefits-not-product`, `Cashvertising`, `advisory-soft`, `never a hard gate`, and the `…more` marker) with a belt-and-suspenders check that a product-led-but-otherwise-rubric-good copy still scores in-range — the "never a hard gate" invariant.

## API

```ts
import type { CreativeBrief } from "./creative-brief";

export type Copy = { headline: string; primaryText: string; description: string };

export type CopyRubricSubs = {
  lf8: 0 | 1 | 2;
  schwartz: 0 | 1 | 2;
  cialdini: 0 | 1 | 2;
  hopkins: 0 | 1 | 2;
  sugarman: 0 | 1 | 2;
};

export type CopyRubricScore = {
  total: number;             // 0..10 (post lead-benefit-signal adjust + clamp)
  subs: CopyRubricSubs;
  leadBenefitPenalty: 0 | -1; // Phase 3 soft rail (2026-07-18)
  evidence: string[];        // ≥5 lines (one per sub-score) + 1 for the lead-benefit signal
};

export function scoreConversionPsychology(copy: Copy, brief: CreativeBrief): CopyRubricScore;
export function renderRubricForPrompt(): string;

export const LF8_SUBSCORE_RUBRIC: string;
export const SCHWARTZ_LEVELS_1_TO_5: string;
export const CIALDINI_PRINCIPLES: string;
export const HOPKINS_SPECIFICITY_RULES: string;
export const SUGARMAN_SLIPPERY_SLIDE: string;
export const LEAD_BENEFIT_SIGNAL: string;   // Phase 3 soft rail (2026-07-18)
```

`renderRubricForPrompt()` returns a **byte-stable** multi-line string that both downstream skill prompts embed verbatim so Dahlia and Max render THE SAME BYTES. Pinned by the test suite.

## Consumers (future — nothing consumes it yet)

The module is the SSOT foundation the downstream specs will import:

- Dahlia's author box session ([[../specs/dahlia-copy-author-box-session]]) — self-scores her own draft on this rubric before persisting.
- Max's QC box session ([[../specs/dahlia-max-independent-copy-qc-box-session]]) — advisory second-opinion score on the same rubric, so a bounce fires when Max disagrees with Dahlia's self-score.
- [[creative-brief]] `buildMetaCopy` — may later gate on a minimum rubric total the same way it already biases toward [[lf8]] keywords.
- [[creative-qa]] — may later attach the rubric score to a `creative_qa` row alongside the LF8 gate finding.

## Tests

`src/lib/ads/copy-rubric.test.ts` — run via `npm run test:copy-rubric`. Pins:

- Every sub-score is in `{0, 1, 2}` and the total is an integer in `0..10`.
- Every sub-score emits ≥1 evidence line (`{key}=…`).
- `scoreConversionPsychology` is pure (same inputs → same output, byte-identical).
- Empty copy earns 0 across the board.
- `renderRubricForPrompt()` is byte-stable across invocations (the **SSOT invariant**).
- The module imports `LF8_KEYWORDS` from `./lf8` and does NOT redeclare it.

## Related

[[lf8]] · [[creative-brief]] · [[creative-qa]] · [[../functions/growth]] · [[../goals/dahlia-imitate-then-innovate-copy-engine]]
